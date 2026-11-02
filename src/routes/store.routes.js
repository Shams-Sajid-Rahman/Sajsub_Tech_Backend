import { Router } from 'express';
import * as store from '../controllers/store.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { idParamSchema } from '../validators/admin.validator.js';
import * as schemas from '../validators/store.validator.js';

const customerOnly = [authenticate, requireRole('CUSTOMER')];
const byProduct = { params: schemas.productIdParamSchema };

export const cartRoutes = Router();
cartRoutes.use(customerOnly);
cartRoutes.get('/', store.getCart);
cartRoutes.delete('/', store.clearCart);
cartRoutes.post('/items', validate({ body: schemas.addItemSchema }), store.addCartItem);
cartRoutes.patch('/items/:productId', validate({ ...byProduct, body: schemas.updateItemSchema }), store.updateCartItem);
cartRoutes.delete('/items/:productId', validate(byProduct), store.removeCartItem);

export const wishlistRoutes = Router();
wishlistRoutes.use(customerOnly);
wishlistRoutes.get('/', store.getWishlist);
wishlistRoutes.post('/items', validate({ body: schemas.addWishlistSchema }), store.addWishlistItem);
wishlistRoutes.delete('/items/:productId', validate(byProduct), store.removeWishlistItem);

wishlistRoutes.post('/items/:productId/move-to-cart', validate(byProduct), store.moveWishlistItemToCart);

export const addressRoutes = Router();
addressRoutes.use(customerOnly);
addressRoutes.get('/', store.getAddresses);
addressRoutes.post('/', validate({ body: schemas.addressSchema }), store.createAddress);
addressRoutes.delete('/:id', validate({ params: idParamSchema }), store.deleteAddress);

export const orderRoutes = Router();
orderRoutes.use(customerOnly);
orderRoutes.get('/', validate({ query: schemas.customerOrderListSchema }), store.getOrders);
orderRoutes.post('/', validate({ body: schemas.placeOrderSchema }), store.placeOrder);
orderRoutes.get('/:id', validate({ params: idParamSchema }), store.getOrder);
orderRoutes.post('/:id/cancel', validate({ params: idParamSchema }), store.cancelOrder);
orderRoutes.post('/:id/payments', validate({ params: idParamSchema }), store.startOrderPayment);
orderRoutes.post('/:id/payments/verify', validate({ params: idParamSchema }), store.checkOrderPayment);
