import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { toSkipTake } from '../utils/pagination.js';
import { updateOrderStatus } from './admin/order.service.js';
import { calculateShipping } from './cart.service.js';
import { adjustStock } from './inventory.service.js';
import { isPurchasable } from './product.service.js';

const generateOrderNumber = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `ST-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
};

// One transaction: if any item can't be fulfilled, no order exists and no stock changes.
// Prices come from the database, and adjustStock refuses to oversell.
export const placeOrder = (userId, { shippingAddress, customerNote }) =>
  prisma.$transaction(async (tx) => {
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

    const lines = cart.items.map(({ product, quantity }) => {
      if (!isPurchasable(product)) throw new ApiError(409, `${product.name} is no longer available`);
      const unitPrice = product.discountPrice ?? product.price;
      return { product, quantity, unitPrice, lineTotal: unitPrice.times(quantity) };
    });
    const subtotal = lines.reduce((sum, { lineTotal }) => sum.plus(lineTotal), new Prisma.Decimal(0));
    const shipping = await calculateShipping(tx, subtotal);
    const total = subtotal.plus(shipping);

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId,
        subtotalAmount: subtotal,
        shippingAmount: shipping,
        totalAmount: total,
        shippingAddress,
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
        payments: { create: { method: 'CASH_ON_DELIVERY', amount: total } },
      },
      include: { items: true, payments: true },
    });

    for (const { product, quantity } of lines) {
      try {
        await adjustStock({ productId: product.id, quantityChange: -quantity, type: 'SALE', orderId: order.id, performedById: userId }, tx);
      } catch (error) {
        if (error.status === 409) throw new ApiError(409, `Not enough stock for ${product.name}`);
        throw error;
      }
    }

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return order;
  });

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
  const order = await prisma.order.findFirst({
    where: { id, userId },
    include: { items: true, payments: { omit: { providerResponse: true } } },
  });
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
};

export const cancelCustomerOrder = async (userId, id) => {
  const order = await getCustomerOrder(userId, id);
  if (order.status !== 'PENDING') throw new ApiError(409, 'This order can no longer be cancelled');
  await updateOrderStatus(id, 'CANCELLED', userId);
  return getCustomerOrder(userId, id);
};
