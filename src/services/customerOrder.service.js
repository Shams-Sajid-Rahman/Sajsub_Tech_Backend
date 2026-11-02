import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { toSkipTake } from '../utils/pagination.js';
import { updateOrderStatus } from './admin/order.service.js';
import { calculateTotals } from './cart.service.js';
import { adjustStock } from './inventory.service.js';
import { isPurchasable } from './product.service.js';

const ORDER_RESULT = { items: true, payments: { omit: { providerResponse: true } } };

const generateOrderNumber = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `ST-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
};

const findByKey = (client, userId, idempotencyKey) =>
  client.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, include: ORDER_RESULT });

const resolveAddress = async (client, userId, addressId, shippingAddress) => {
  if (shippingAddress) return shippingAddress;
  const saved = await client.address.findFirst({ where: { id: addressId, userId } });
  if (!saved) throw new ApiError(404, 'Address not found');
  const { fullName, phone, line1, line2, city, state, postalCode, country } = saved;
  return { fullName, phone, line1, line2, city, state, postalCode, country };
};

// One transaction: if any item can't be fulfilled, no order exists and no stock changes.
const createOrder = (userId, { addressId, shippingAddress, paymentMethod, idempotencyKey, expectedTotal, customerNote }) =>
  prisma.$transaction(async (tx) => {
    // Locks the cart, so simultaneous checkouts by one customer run one after the other.
    await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "userId" = ${userId}::uuid FOR UPDATE`;

    const cart = await tx.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              include: {
                category: { select: { isActive: true } },
                brand: { select: { isActive: true } },
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
          },
        },
      },
    });
    if (!cart || cart.items.length === 0) throw new ApiError(400, 'Your cart is empty');

    const address = await resolveAddress(tx, userId, addressId, shippingAddress);

    const lines = cart.items.map(({ product, quantity }) => {
      if (!isPurchasable(product)) throw new ApiError(409, `${product.name} is no longer available`);
      const unitPrice = product.discountPrice ?? product.price;
      return { product, quantity, price: product.price, unitPrice, lineTotal: unitPrice.times(quantity) };
    });
    const { subtotal, discount, shipping, total } = await calculateTotals(tx, lines);

    // Prices may have changed while the customer was checking out.
    if (expectedTotal && !total.equals(new Prisma.Decimal(expectedTotal))) {
      throw new ApiError(409, 'Prices have changed. Please review your order total and try again.');
    }

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        idempotencyKey,
        userId,
        subtotalAmount: subtotal,
        discountAmount: discount,
        shippingAmount: shipping,
        totalAmount: total,
        shippingAddress: address,
        customerNote,
        items: {
          create: lines.map(({ product, quantity, unitPrice, lineTotal }) => ({
            productId: product.id,
            productName: product.name,
            productSku: product.sku,
            imageUrl: product.images[0]?.url,
            unitPrice,
            quantity,
            lineTotal,
          })),
        },
        payments: { create: { method: paymentMethod, amount: total } },
      },
    });

    // Stock is checked again here, inside the transaction.
    for (const { product, quantity } of lines) {
      try {
        await adjustStock({ productId: product.id, quantityChange: -quantity, type: 'SALE', orderId: order.id, performedById: userId }, tx);
      } catch (error) {
        if (error.status === 409) throw new ApiError(409, `Not enough stock for ${product.name}`);
        throw error;
      }
    }

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return tx.order.findUnique({ where: { id: order.id }, include: ORDER_RESULT });
  });

// A repeated request with the same key returns the original order instead of creating another.
export const placeOrder = async (userId, input) => {
  const { idempotencyKey } = input;
  const existing = await findByKey(prisma, userId, idempotencyKey);
  if (existing) return { order: existing, created: false };

  try {
    return { order: await createOrder(userId, input), created: true };
  } catch (error) {
    // A duplicate may have finished first, leaving this request with an empty cart or a key conflict.
    const winner = await findByKey(prisma, userId, idempotencyKey);
    if (winner) return { order: winner, created: false };
    throw error;
  }
};

export const listCustomerOrders = async (userId, pagination) => {
  const where = { userId };
  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: { items: { take: 3 }, _count: { select: { items: true } } },
      orderBy: { placedAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.order.count({ where }),
  ]);
  return { items, total };
};

// Someone else's order looks exactly like one that doesn't exist.
export const getCustomerOrder = async (userId, id) => {
  const order = await prisma.order.findFirst({ where: { id, userId }, include: ORDER_RESULT });
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
};

export const cancelCustomerOrder = async (userId, id) => {
  const order = await getCustomerOrder(userId, id);
  if (order.status !== 'PENDING') throw new ApiError(409, 'This order can no longer be cancelled');
  await updateOrderStatus(id, 'CANCELLED', userId);
  return getCustomerOrder(userId, id);
};
