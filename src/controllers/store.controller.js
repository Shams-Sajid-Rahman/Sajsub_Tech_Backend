import * as addresses from '../services/address.service.js';
import * as cart from '../services/cart.service.js';
import * as orders from '../services/customerOrder.service.js';
import { sendContactEmail } from '../services/email.service.js';
import * as products from '../services/product.service.js';
import * as reviews from '../services/review.service.js';
import { getSiteContent } from '../services/site.service.js';
import * as wishlist from '../services/wishlist.service.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPaginationMeta } from '../utils/pagination.js';
import { sendSuccess } from '../utils/response.js';

const body = (req) => req.validated.body;
const productId = (req) => req.validated.params.productId;
const slug = (req) => req.validated.params.slug;

export const getSite = async (req, res) => sendSuccess(res, await getSiteContent());

export const getCart = async (req, res) => sendSuccess(res, await cart.getCart(req.user.id));
export const addCartItem = async (req, res) => sendSuccess(res, await cart.addCartItem(req.user.id, body(req)), { status: 201 });
export const updateCartItem = async (req, res) =>
  sendSuccess(res, await cart.updateCartItem(req.user.id, productId(req), body(req).quantity));
export const removeCartItem = async (req, res) => sendSuccess(res, await cart.removeCartItem(req.user.id, productId(req)));
export const clearCart = async (req, res) => sendSuccess(res, await cart.clearCart(req.user.id));

export const getWishlist = async (req, res) => sendSuccess(res, await wishlist.getWishlist(req.user.id));
export const addWishlistItem = async (req, res) =>
  sendSuccess(res, await wishlist.addWishlistItem(req.user.id, body(req).productId), { status: 201 });
export const removeWishlistItem = async (req, res) => sendSuccess(res, await wishlist.removeWishlistItem(req.user.id, productId(req)));

export const moveWishlistItemToCart = async (req, res) =>
  sendSuccess(res, await wishlist.moveWishlistItemToCart(req.user.id, productId(req)), { message: 'Moved to cart' });

export const getAddresses = async (req, res) => sendSuccess(res, await addresses.listAddresses(req.user.id));
export const createAddress = async (req, res) =>
  sendSuccess(res, await addresses.createAddress(req.user.id, body(req)), { status: 201, message: 'Address saved' });
export const deleteAddress = async (req, res) =>
  sendSuccess(res, await addresses.deleteAddress(req.user.id, req.validated.params.id), { message: 'Address deleted' });

export const placeOrder = async (req, res) => {
  const { order, created } = await orders.placeOrder(req.user.id, body(req));
  sendSuccess(res, order, { status: created ? 201 : 200, message: 'Order placed' });
};
export const getOrders = async (req, res) => {
  const { query } = req.validated;
  const { items, total } = await orders.listCustomerOrders(req.user.id, query);
  sendSuccess(res, items, { meta: buildPaginationMeta(query, total) });
};
export const getOrder = async (req, res) => sendSuccess(res, await orders.getCustomerOrder(req.user.id, req.validated.params.id));
export const cancelOrder = async (req, res) =>
  sendSuccess(res, await orders.cancelCustomerOrder(req.user.id, req.validated.params.id), { message: 'Order cancelled' });

export const getRelatedProducts = async (req, res) => sendSuccess(res, await products.getRelatedProducts(slug(req)));
export const getReviews = async (req, res) => {
  const { query } = req.validated;
  const { items, total } = await reviews.listReviews(slug(req), query);
  sendSuccess(res, items, { meta: buildPaginationMeta(query, total) });
};
export const saveReview = async (req, res) =>
  sendSuccess(res, await reviews.saveReview(req.user.id, slug(req), body(req)), { message: 'Review saved' });

export const sendContact = async (req, res) => {
  try {
    await sendContactEmail(body(req));
  } catch (error) {
    console.error('Contact message failed:', error.message);
    throw new ApiError(503, 'Your message could not be sent right now. Please try again later.');
  }
  sendSuccess(res, null, { message: "Thanks! We've received your message." });
};
