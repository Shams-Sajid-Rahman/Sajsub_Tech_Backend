import { adjustStock } from '../services/inventory.service.js';
import * as catalog from '../services/admin/catalog.service.js';
import * as content from '../services/admin/content.service.js';
import * as images from '../services/admin/image.service.js';
import * as logs from '../services/admin/log.service.js';
import * as orders from '../services/admin/order.service.js';
import * as products from '../services/admin/product.service.js';
import { verifyPaymentById } from '../services/payments/payment.service.js';
import * as stats from '../services/admin/stats.service.js';
import * as users from '../services/admin/user.service.js';
import { buildPaginationMeta } from '../utils/pagination.js';
import { sendSuccess } from '../utils/response.js';

const list = (fetch) => async (req, res) => {
  const { query } = req.validated;
  const { items, total } = await fetch(query);
  sendSuccess(res, items, { meta: buildPaginationMeta(query, total) });
};

const read = (fetch) => async (req, res) => {
  sendSuccess(res, await fetch(req));
};

// Runs an admin change, then records who did it in the activity log.
const audited = (action, entityType, run, { status = 200, message = 'Saved' } = {}) =>
  async (req, res) => {
    const result = await run(req);
    await logs.logAudit({
      actorId: req.user.id,
      ipAddress: req.ip,
      action: typeof action === 'function' ? action(result) : action,
      entityType,
      entityId: String(result?.id ?? result?.key ?? req.params.id ?? req.params.key ?? ''),
      changes: req.validated?.body,
    });
    sendSuccess(res, result, { status, message: typeof message === 'function' ? message(result) : message });
  };

// Deleting reports what actually happened, because records with history are archived instead.
const removed = (entity, entityType, run) =>
  audited(({ outcome }) => `${entity}.${outcome}`, entityType, run, {
    message: ({ outcome }) =>
      outcome === 'deleted' ? `${entityType} deleted` : `${entityType} archived, because it has linked records`,
  });

const uploadedFiles = (req) => req.files;
const imageId = (req) => req.validated.params.imageId;

const CREATED = { status: 201, message: 'Created' };
const body = (req) => req.validated.body;
const id = (req) => req.validated.params.id;

export const getStats = read(() => stats.getDashboardStats());
export const getNotifications = read(() => stats.getNotifications());

export const getUsers = list(users.listUsers);
export const setUserStatus = audited('user.status_changed', 'User', (req) =>
  users.updateUserStatus(id(req), body(req).status),
);

export const getProducts = list(products.listAdminProducts);
export const getProduct = read((req) => products.getAdminProduct(id(req)));
export const createProduct = audited('product.created', 'Product', (req) => products.createProduct(body(req), req.user.id), CREATED);
export const updateProduct = audited('product.updated', 'Product', (req) => products.updateProduct(id(req), body(req)));
export const deleteProduct = removed('product', 'Product', (req) => products.deleteProduct(id(req)));
export const addProductImages = audited(
  'product.images_added',
  'Product',
  async (req) => ({ id: id(req), images: await images.addProductImages(id(req), uploadedFiles(req)) }),
  { status: 201, message: 'Images uploaded' },
);
export const replaceProductImage = audited('product.image_replaced', 'ProductImage', (req) =>
  images.replaceProductImage(id(req), imageId(req), req.file),
);
export const setPrimaryProductImage = audited('product.image_primary_set', 'ProductImage', (req) =>
  images.setPrimaryProductImage(id(req), imageId(req)),
);
export const deleteProductImage = audited('product.image_deleted', 'ProductImage', (req) =>
  images.deleteProductImage(id(req), imageId(req)), { message: 'Image deleted' },
);

export const getCategories = list(catalog.listAdminCategories);
export const createCategory = audited('category.created', 'Category', (req) => catalog.createCategory(body(req)), CREATED);
export const updateCategory = audited('category.updated', 'Category', (req) => catalog.updateCategory(id(req), body(req)));
export const deleteCategory = removed('category', 'Category', (req) => catalog.deleteCategory(id(req)));
export const setCategoryImage = audited('category.image_set', 'Category', (req) =>
  images.setCategoryImage(id(req), req.file), { message: 'Image uploaded' },
);
export const removeCategoryImage = audited('category.image_removed', 'Category', (req) =>
  images.removeCategoryImage(id(req)), { message: 'Image removed' },
);

export const getBrands = list(catalog.listAdminBrands);
export const createBrand = audited('brand.created', 'Brand', (req) => catalog.createBrand(body(req)), CREATED);
export const updateBrand = audited('brand.updated', 'Brand', (req) => catalog.updateBrand(id(req), body(req)));
export const deleteBrand = removed('brand', 'Brand', (req) => catalog.deleteBrand(id(req)));

export const getInventory = list(logs.listInventoryTransactions);
export const adjustInventory = audited(
  'inventory.adjusted',
  'InventoryTransaction',
  (req) => adjustStock({ ...body(req), performedById: req.user.id }),
  CREATED,
);

export const getOrders = list(orders.listOrders);
export const getOrder = read((req) => orders.getOrder(id(req)));
export const setOrderStatus = audited('order.status_changed', 'Order', (req) =>
  (({ status, ...details }) => orders.updateOrderStatus(id(req), status, { ...details, changedById: req.user.id }))(body(req)),
);

export const getPayments = list(orders.listPayments);
export const setPaymentStatus = audited('payment.status_changed', 'Payment', (req) =>
  orders.updatePaymentStatus(id(req), body(req).status),
);
export const refundPayment = audited(
  'payment.refunded',
  'Payment',
  (req) => orders.refundPayment(id(req), body(req), req.user.id),
  { status: 201, message: 'Refund recorded' },
);
export const verifyPayment = audited('payment.verified', 'Payment', (req) => verifyPaymentById(id(req)), {
  message: ({ outcome }) => `Provider result: ${outcome}`,
});

export const getBanners = list(content.listBanners);
export const createBanner = audited('banner.created', 'Banner', (req) => content.createBanner(body(req)), CREATED);
export const updateBanner = audited('banner.updated', 'Banner', (req) => content.updateBanner(id(req), body(req)));
export const deleteBanner = audited('banner.deleted', 'Banner', (req) => content.deleteBanner(id(req)), { message: 'Deleted' });

export const getSettings = list(content.listSettings);
export const saveSetting = audited('setting.saved', 'SiteSetting', (req) =>
  content.saveSetting(req.validated.params.key, body(req)),
);
export const deleteSetting = audited('setting.deleted', 'SiteSetting', (req) =>
  content.deleteSetting(req.validated.params.key), { message: 'Deleted' },
);

export const getAuditLogs = list(logs.listAuditLogs);
export const getLoginLogs = list(logs.listLoginLogs);
