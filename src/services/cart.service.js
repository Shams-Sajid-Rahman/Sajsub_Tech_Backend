import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { CARD_INCLUDE, isPurchasable, toPublicProduct } from './product.service.js';

const DEFAULT_SHIPPING_FEE = 120;

const getSettingNumber = async (client, key, fallback) => {
  const setting = await client.siteSetting.findUnique({ where: { key } });
  const value = Number(setting?.value);
  return Number.isFinite(value) ? value : fallback;
};

// Free above the threshold. With no threshold setting, every order pays the flat fee.
export const calculateShipping = async (client, subtotal) => {
  const threshold = await getSettingNumber(client, 'free_shipping_threshold', Infinity);
  const fee = await getSettingNumber(client, 'shipping_fee', DEFAULT_SHIPPING_FEE);
  return subtotal.gte(threshold) || subtotal.isZero() ? new Prisma.Decimal(0) : new Prisma.Decimal(fee);
};

const CART_ITEMS = { orderBy: { createdAt: 'asc' }, include: { product: { include: CARD_INCLUDE } } };

// List-price subtotal, savings, shipping and total. Shipping is based on what the customer pays for goods.
export const calculateTotals = async (client, lines) => {
  const zero = new Prisma.Decimal(0);
  const subtotal = lines.reduce((sum, { price, quantity }) => sum.plus(price.times(quantity)), zero);
  const goods = lines.reduce((sum, { unitPrice, quantity }) => sum.plus(unitPrice.times(quantity)), zero);
  const shipping = await calculateShipping(client, goods);
  return { subtotal, discount: subtotal.minus(goods), shipping, total: goods.plus(shipping) };
};

const findIssue = (product, quantity) => {
  if (!isPurchasable(product)) return 'UNAVAILABLE';
  if (product.stockQuantity === 0) return 'OUT_OF_STOCK';
  if (product.stockQuantity < quantity) return 'NOT_ENOUGH_STOCK';
  return null;
};

const getOrCreateCart = (client, userId) =>
  client.cart.upsert({ where: { userId }, update: {}, create: { userId } });

export const getCart = async (userId) => {
  const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: CART_ITEMS } });
  const rows = cart?.items ?? [];
  const items = rows.map(({ quantity, product }) => {
    const issue = findIssue(product, quantity);
    return {
      productId: product.id,
      quantity,
      available: !issue,
      issue,
      // Only revealed when it explains a problem. Normally customers see just "in stock".
      stockAvailable: issue === 'NOT_ENOUGH_STOCK' ? product.stockQuantity : undefined,
      lineTotal: (product.discountPrice ?? product.price).times(quantity).toFixed(2),
      product: toPublicProduct(product),
    };
  });
  const totals = await calculateTotals(
    prisma,
    rows.map(({ quantity, product }) => ({
      quantity,
      price: product.price,
      unitPrice: product.discountPrice ?? product.price,
    })),
  );
  return {
    items,
    itemCount: items.reduce((sum, { quantity }) => sum + quantity, 0),
    subtotal: totals.subtotal.toFixed(2),
    discount: totals.discount.toFixed(2),
    shipping: totals.shipping.toFixed(2),
    total: totals.total.toFixed(2),
  };
};

const findPurchasable = async (productId, requestedQuantity) => {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: CARD_INCLUDE });
  if (!product || !isPurchasable(product)) throw new ApiError(404, 'Product not found');
  if (product.stockQuantity < requestedQuantity) {
    throw new ApiError(409, product.stockQuantity === 0 ? 'This product is out of stock' : `Only ${product.stockQuantity} left in stock`);
  }
  return product;
};

export const addCartItem = async (userId, { productId, quantity }) => {
  const cart = await getOrCreateCart(prisma, userId);
  const existing = await prisma.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId } } });
  const nextQuantity = (existing?.quantity ?? 0) + quantity;
  await findPurchasable(productId, nextQuantity);
  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    update: { quantity: nextQuantity },
    create: { cartId: cart.id, productId, quantity },
  });
  return getCart(userId);
};

export const updateCartItem = async (userId, productId, quantity) => {
  await findPurchasable(productId, quantity);
  const { count } = await prisma.cartItem.updateMany({ where: { productId, cart: { userId } }, data: { quantity } });
  if (count === 0) throw new ApiError(404, 'This item is not in your cart');
  return getCart(userId);
};

export const removeCartItem = async (userId, productId) => {
  await prisma.cartItem.deleteMany({ where: { productId, cart: { userId } } });
  return getCart(userId);
};

export const clearCart = async (userId) => {
  await prisma.cartItem.deleteMany({ where: { cart: { userId } } });
  return getCart(userId);
};
