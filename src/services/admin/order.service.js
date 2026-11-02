import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSkipTake } from '../../utils/pagination.js';
import { adjustStock } from '../inventory.service.js';

const ORDER_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};

const PAYMENT_TRANSITIONS = {
  PENDING: ['PAID', 'FAILED'],
  FAILED: ['PENDING'],
  PAID: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  REFUNDED: [],
};

const RESTOCK_TYPE = { CANCELLED: 'ORDER_CANCELLED', RETURNED: 'CUSTOMER_RETURN' };

const withOrderActions = (order) => ({ ...order, allowedStatuses: ORDER_TRANSITIONS[order.status] });
const withPaymentActions = (payment) => ({ ...payment, allowedStatuses: PAYMENT_TRANSITIONS[payment.status] });

const CUSTOMER_SELECT = { select: { id: true, email: true, firstName: true, lastName: true } };

export const listOrders = async ({ search, status, paymentStatus, ...pagination }) => {
  const where = {
    ...(status && { status }),
    ...(paymentStatus && { paymentStatus }),
    ...(search && {
      OR: [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: { user: CUSTOMER_SELECT, _count: { select: { items: true } } },
      orderBy: { placedAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.order.count({ where }),
  ]);
  return { items: items.map(withOrderActions), total };
};

export const getOrder = async (id) => {
  const order = await prisma.order.findUnique({
    where: { id },
    include: { user: CUSTOMER_SELECT, items: true, payments: { orderBy: { createdAt: 'desc' } } },
  });
  if (!order) throw new ApiError(404, 'Order not found');
  return withOrderActions(order);
};

// Puts back whatever the order's ledger entries still hold, so stock can't be restored twice.
const restoreOrderStock = async (tx, orderId, type, performedById) => {
  const entries = await tx.inventoryTransaction.groupBy({
    by: ['productId'],
    where: { orderId },
    _sum: { quantityChange: true },
  });
  for (const { productId, _sum } of entries) {
    if (_sum.quantityChange < 0) {
      await adjustStock({ productId, quantityChange: -_sum.quantityChange, type, orderId, performedById }, tx);
    }
  }
};

export const updateOrderStatus = (id, status, performedById) =>
  prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id }, select: { status: true } });
    if (!order) throw new ApiError(404, 'Order not found');
    if (!ORDER_TRANSITIONS[order.status].includes(status)) {
      throw new ApiError(409, `An order cannot move from ${order.status} to ${status}`);
    }

    // Conditional, so two admins acting at once can't both apply a change.
    const { count } = await tx.order.updateMany({
      where: { id, status: order.status },
      data: {
        status,
        ...(status === 'CANCELLED' && { cancelledAt: new Date() }),
        ...(status === 'DELIVERED' && { deliveredAt: new Date() }),
      },
    });
    if (count === 0) throw new ApiError(409, 'This order was just changed. Please reload.');

    if (RESTOCK_TYPE[status]) await restoreOrderStock(tx, id, RESTOCK_TYPE[status], performedById);
    return withOrderActions(await tx.order.findUnique({ where: { id } }));
  });

export const listPayments = async ({ search, status, method, ...pagination }) => {
  const where = {
    ...(status && { status }),
    ...(method && { method }),
    ...(search && {
      OR: [
        { providerTransactionId: { contains: search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where,
      omit: { providerResponse: true },
      include: { order: { select: { orderNumber: true, user: { select: { email: true } } } } },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.payment.count({ where }),
  ]);
  return { items: items.map(withPaymentActions), total };
};

export const updatePaymentStatus = (id, status) =>
  prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id }, select: { status: true, orderId: true } });
    if (!payment) throw new ApiError(404, 'Payment not found');
    if (!PAYMENT_TRANSITIONS[payment.status].includes(status)) {
      throw new ApiError(409, `A payment cannot move from ${payment.status} to ${status}`);
    }
    const { count } = await tx.payment.updateMany({
      where: { id, status: payment.status },
      data: { status, ...(status === 'PAID' && { paidAt: new Date() }) },
    });
    if (count === 0) throw new ApiError(409, 'This payment was just changed. Please reload.');

    await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: status } });
    return withPaymentActions(await tx.payment.findUnique({ where: { id }, omit: { providerResponse: true } }));
  });
