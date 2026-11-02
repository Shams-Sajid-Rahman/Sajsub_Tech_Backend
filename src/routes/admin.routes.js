import { Router } from 'express';
import * as admin from '../controllers/admin.controller.js';
import * as auth from '../controllers/auth.controller.js';
import { requireAdmin } from '../middleware/auth.middleware.js';
import { notFound } from '../middleware/error.middleware.js';
import { loginLimiter } from '../middleware/rateLimit.middleware.js';
import { uploadImageField, uploadImagesField } from '../middleware/upload.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as schemas from '../validators/admin.validator.js';
import { changePasswordSchema, loginSchema, updateProfileSchema } from '../validators/auth.validator.js';

const router = Router();

const byId = { params: schemas.idParamSchema };
const byKey = { params: schemas.settingKeyParamSchema };
const byImage = { params: schemas.productImageParamSchema };

router.post('/auth/login', loginLimiter, validate({ body: loginSchema }), auth.adminLogin);
router.post('/auth/logout', auth.logout);

// Every route below this line requires an admin session.
router.use(requireAdmin);

router.get('/profile', auth.getMe);
router.patch('/profile', validate({ body: updateProfileSchema }), auth.updateMe);
router.post('/profile/change-password', loginLimiter, validate({ body: changePasswordSchema }), auth.changePassword);

router.get('/stats', admin.getStats);
router.get('/notifications', admin.getNotifications);

router.get('/users', validate({ query: schemas.userListSchema }), admin.getUsers);
router.patch('/users/:id/status', validate({ ...byId, body: schemas.userStatusSchema }), admin.setUserStatus);

router.get('/products', validate({ query: schemas.adminProductListSchema }), admin.getProducts);
router.post('/products', validate({ body: schemas.productCreateSchema }), admin.createProduct);
router.get('/products/:id', validate(byId), admin.getProduct);
router.patch('/products/:id', validate({ ...byId, body: schemas.productUpdateSchema }), admin.updateProduct);
router.delete('/products/:id', validate(byId), admin.deleteProduct);
router.post('/products/:id/images', validate(byId), uploadImagesField, admin.addProductImages);
router.put('/products/:id/images/:imageId', validate(byImage), uploadImageField, admin.replaceProductImage);
router.patch('/products/:id/images/:imageId/primary', validate(byImage), admin.setPrimaryProductImage);
router.delete('/products/:id/images/:imageId', validate(byImage), admin.deleteProductImage);

router.get('/categories', validate({ query: schemas.adminCatalogListSchema }), admin.getCategories);
router.post('/categories', validate({ body: schemas.categoryCreateSchema }), admin.createCategory);
router.patch('/categories/:id', validate({ ...byId, body: schemas.categoryUpdateSchema }), admin.updateCategory);
router.delete('/categories/:id', validate(byId), admin.deleteCategory);
router.put('/categories/:id/image', validate(byId), uploadImageField, admin.setCategoryImage);
router.delete('/categories/:id/image', validate(byId), admin.removeCategoryImage);

router.get('/brands', validate({ query: schemas.adminCatalogListSchema }), admin.getBrands);
router.post('/brands', validate({ body: schemas.brandCreateSchema }), admin.createBrand);
router.patch('/brands/:id', validate({ ...byId, body: schemas.brandUpdateSchema }), admin.updateBrand);
router.delete('/brands/:id', validate(byId), admin.deleteBrand);

router.get('/inventory', validate({ query: schemas.inventoryListSchema }), admin.getInventory);
router.post('/inventory/adjust', validate({ body: schemas.inventoryAdjustSchema }), admin.adjustInventory);

router.get('/orders', validate({ query: schemas.orderListSchema }), admin.getOrders);
router.get('/orders/:id', validate(byId), admin.getOrder);
router.patch('/orders/:id/status', validate({ ...byId, body: schemas.orderStatusSchema }), admin.setOrderStatus);

router.get('/payments', validate({ query: schemas.paymentListSchema }), admin.getPayments);
router.patch('/payments/:id/status', validate({ ...byId, body: schemas.paymentStatusSchema }), admin.setPaymentStatus);

router.get('/banners', validate({ query: schemas.bannerListSchema }), admin.getBanners);
router.post('/banners', validate({ body: schemas.bannerCreateSchema }), admin.createBanner);
router.patch('/banners/:id', validate({ ...byId, body: schemas.bannerUpdateSchema }), admin.updateBanner);
router.delete('/banners/:id', validate(byId), admin.deleteBanner);

router.get('/settings', validate({ query: schemas.settingListSchema }), admin.getSettings);
router.put('/settings/:key', validate({ ...byKey, body: schemas.settingSaveSchema }), admin.saveSetting);
router.delete('/settings/:key', validate(byKey), admin.deleteSetting);

router.get('/logs/activity', validate({ query: schemas.auditLogListSchema }), admin.getAuditLogs);
router.get('/logs/logins', validate({ query: schemas.loginLogListSchema }), admin.getLoginLogs);

router.use(notFound);

export default router;
