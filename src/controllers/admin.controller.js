import { adjustStock } from '../services/inventory.service.js';
import * as catalog from '../services/admin/catalog.service.js';
import * as content from '../services/admin/content.service.js';
import * as logs from '../services/admin/log.service.js';
import * as orders from '../services/admin/order.service.js';
import * as products from '../services/admin/product.service.js';
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
      action,
      entityType,
      entityId: String(result?.id ?? result?.key ?? req.params.id ?? req.params.key ?? ''),
      changes: req.validated?.body,
    });
    sendSuccess(res, result, { status, message });
  };

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
export const archiveProduct = audited('product.archived', 'Product', (req) => products.archiveProduct(id(req)), { message: 'Archived' });

export const getCategories = list(catalog.listAdminCategories);
export const createCategory = audited('category.created', 'Category', (req) => catalog.createCategory(body(req)), CREATED);
export const updateCategory = audited('category.updated', 'Category', (req) => catalog.updateCategory(id(req), body(req)));
export const archiveCategory = audited('category.archived', 'Category', (req) => catalog.archiveCategory(id(req)), { message: 'Archived' });

export const getBrands = list(catalog.listAdminBrands);
export const createBrand = audited('brand.created', 'Brand', (req) => catalog.createBrand(body(req)), CREATED);
export const updateBrand = audited('brand.updated', 'Brand', (req) => catalog.updateBrand(id(req), body(req)));
export const archiveBrand = audited('brand.archived', 'Brand', (req) => catalog.archiveBrand(id(req)), { message: 'Archived' });

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
  orders.updateOrderStatus(id(req), body(req).status, req.user.id),
);

export const getPayments = list(orders.listPayments);
export const setPaymentStatus = audited('payment.status_changed', 'Payment', (req) =>
  orders.updatePaymentStatus(id(req), body(req).status),
);

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
