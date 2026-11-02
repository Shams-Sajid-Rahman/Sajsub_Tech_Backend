import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSkipTake } from '../../utils/pagination.js';
import { adjustStock } from '../inventory.service.js';

// REFUNDED is reached through a refund, never by changing the status directly.
const ORDER_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
};

// Online payments only change through verification with the provider, so this is cash on delivery only.
const CASH_PAYMENT_TRANSITIONS = {
  PENDING: ['PAID', 'FAILED'],
  FAILED: ['PENDING'],
  PAID: [],
  PARTIALLY_REFUNDED: [],
  REFUNDED: [],
};

const COLLECTED_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'];
const REFUNDABLE_ORDER_STATUSES = ['DELIVERED', 'CANCELLED', 'REFUNDED'];
const CLOSED_ORDER_STATUSES = ['CANCELLED', 'REFUNDED'];

const withOrderActions = (order) => ({ ...order, allowedStatuses: ORDER_TRANSITIONS[order.status] });
const withPaymentActions = (payment) => ({
  ...payment,
  allowedStatuses:
    payment.method === 'ONLINE' || CLOSED_ORDER_STATUSES.includes(payment.order?.status)
      ? []
      : CASH_PAYMENT_TRANSITIONS[payment.status],
  refundable: COLLECTED_STATUSES.includes(payment.status) ? payment.amount.minus(payment.refundedAmount).toFixed(2) : '0.00',
});

const CUSTOMER_SELECT = { select: { id: true, email: true, firstName: true, lastName: true, phone: true } };

const lockOrder = (tx, orderId) => tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;

export const listOrders = async ({ search, status, paymentStatus, ...pagination }) => {
  const where = {
    ...(status && { status }),
    ...(paymentStatus && { paymentStatus }),
    ...(search && {
      OR: [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
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
    include: {
      user: CUSTOMER_SELECT,
      items: true,
      payments: { omit: { providerResponse: true, gatewayUrl: true }, orderBy: { createdAt: 'desc' } },
      refunds: { include: { createdBy: { select: { email: true } } }, orderBy: { createdAt: 'desc' } },
      statusHistory: { include: { changedBy: { select: { email: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order) throw new ApiError(404, 'Order not found');
  return {
    ...withOrderActions(order),
    payments: order.payments.map((payment) => withPaymentActions({ ...payment, order: { status: order.status } })),
  };
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

// Unpaid attempts end. Money already collected stays recorded and is flagged for an admin to refund.
const settlePaymentsOnCancel = async (tx, order) => {
  await tx.payment.updateMany({
    where: { orderId: order.id, status: 'PENDING' },
    data: { status: 'FAILED', failureReason: 'Order cancelled' },
  });
  await tx.payment.updateMany({
    where: { orderId: order.id, status: { in: COLLECTED_STATUSES } },
    data: { needsRefund: true },
  });
  if (order.paymentStatus === 'PENDING') {
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'FAILED' } });
  }
};

export const updateOrderStatus = (id, status, { changedById, note, trackingNumber, carrier } = {}) =>
  prisma.$transaction(async (tx) => {
    await lockOrder(tx, id);
    const order = await tx.order.findUnique({
      where: { id },
      select: { id: true, status: true, paymentMethod: true, paymentStatus: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    if (!ORDER_TRANSITIONS[order.status].includes(status)) {
      throw new ApiError(409, `An order cannot move from ${order.status} to ${status}`);
    }
    if (order.paymentMethod === 'ONLINE' && status !== 'CANCELLED' && order.paymentStatus !== 'PAID') {
      throw new ApiError(409, 'This order cannot go ahead until its online payment is verified');
    }

    await tx.order.update({
      where: { id },
      data: {
        status,
        ...(status === 'CANCELLED' && { cancelledAt: new Date() }),
        ...(status === 'DELIVERED' && { deliveredAt: new Date() }),
        ...(trackingNumber && { trackingNumber }),
        ...(carrier && { carrier }),
      },
    });
    await tx.orderStatusHistory.create({ data: { orderId: id, status, note, changedById } });

    if (status === 'CANCELLED') {
      await restoreOrderStock(tx, id, 'ORDER_CANCELLED', changedById);
      await settlePaymentsOnCancel(tx, order);
    }
    return withOrderActions(await tx.order.findUnique({ where: { id } }));
  });

export const listPayments = async ({ search, status, method, needsRefund, ...pagination }) => {
  const where = {
    ...(status && { status }),
    ...(method && { method }),
    ...(needsRefund !== undefined && { needsRefund }),
    ...(search && {
      OR: [
        { providerTransactionId: { contains: search, mode: 'insensitive' } },
        { transactionRef: { contains: search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where,
      omit: { providerResponse: true, gatewayUrl: true },
      include: { order: { select: { id: true, orderNumber: true, status: true, user: { select: { email: true } } } } },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.payment.count({ where }),
  ]);
  return { items: items.map(withPaymentActions), total };
};

export const updatePaymentStatus = (id, status) =>
  prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id },
      select: { status: true, orderId: true, method: true, order: { select: { status: true } } },
    });
    if (!payment) throw new ApiError(404, 'Payment not found');
    if (payment.method === 'ONLINE') {
      throw new ApiError(409, 'Online payments can only change through verification with the provider');
    }
    if (CLOSED_ORDER_STATUSES.includes(payment.order.status)) {
      throw new ApiError(409, 'This order is closed');
    }
    if (!CASH_PAYMENT_TRANSITIONS[payment.status].includes(status)) {
      throw new ApiError(409, `A payment cannot move from ${payment.status} to ${status}`);
    }
    const { count } = await tx.payment.updateMany({
      where: { id, status: payment.status },
      data: { status, ...(status === 'PAID' && { paidAt: new Date() }) },
    });
    if (count === 0) throw new ApiError(409, 'This payment was just changed. Please reload.');

    await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: status } });
    return withPaymentActions(await tx.payment.findUnique({
      where: { id },
      omit: { providerResponse: true, gatewayUrl: true },
      include: { order: { select: { status: true } } },
    }));
  });

// Records a refund the admin has issued. No money moves from here: online refunds are made
// in the provider's merchant panel, and the reference is recorded with this entry.
export const refundPayment = (id, { amount, reason, reference, restock }, createdById) =>
  prisma.$transaction(async (tx) => {
    const found = await tx.payment.findUnique({ where: { id }, select: { orderId: true } });
    if (!found) throw new ApiError(404, 'Payment not found');
    await lockOrder(tx, found.orderId);

    const payment = await tx.payment.findUnique({ where: { id }, include: { order: true } });
    if (!COLLECTED_STATUSES.includes(payment.status)) throw new ApiError(409, 'Only collected payments can be refunded');

    const remaining = payment.amount.minus(payment.refundedAmount);
    const refundAmount = amount ? new Prisma.Decimal(amount) : remaining;
    if (refundAmount.gt(remaining)) throw new ApiError(400, `At most ${remaining.toFixed(2)} can be refunded`);

    // A second payment for one order can be returned at any time, without touching the order.
    const isStrayPayment =
      payment.needsRefund &&
      (await tx.payment.count({
        where: { orderId: payment.orderId, id: { not: id }, status: { in: COLLECTED_STATUSES }, needsRefund: false },
      })) > 0;
    if (!isStrayPayment && !REFUNDABLE_ORDER_STATUSES.includes(payment.order.status)) {
      throw new ApiError(409, 'Cancel the order first, or wait until it has been delivered');
    }

    const isFull = refundAmount.equals(remaining);
    const paymentStatus = isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const refund = await tx.refund.create({
      data: { orderId: payment.orderId, paymentId: id, amount: refundAmount, reason, reference, createdById },
    });
    await tx.payment.update({
      where: { id },
      data: {
        status: paymentStatus,
        refundedAmount: payment.refundedAmount.plus(refundAmount),
        needsRefund: isFull ? false : payment.needsRefund,
      },
    });

    if (!isStrayPayment) {
      const closesOrder = isFull && payment.order.status !== 'REFUNDED';
      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus, ...(closesOrder && { status: 'REFUNDED' }) },
      });
      if (closesOrder) {
        await tx.orderStatusHistory.create({
          data: { orderId: payment.orderId, status: 'REFUNDED', note: reason, changedById: createdById },
        });
      }
      // Only returned goods go back on sale, and only when the admin says they are sellable.
      if (isFull && restock) await restoreOrderStock(tx, payment.orderId, 'CUSTOMER_RETURN', createdById);
    }
    return refund;
  });
