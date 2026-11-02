import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { updateOrderStatus } from '../admin/order.service.js';
import { paymentGateway } from './sslcommerz.gateway.js';

const REUSE_SESSION_MS = 2 * 60 * 1000;
export const UNPAID_ORDER_LIMIT_MINUTES = 30;

const COLLECTED_STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const FAILED_PROVIDER_STATUSES = new Set(['FAILED', 'CANCELLED', 'EXPIRED', 'UNATTEMPTED']);

const generateReference = () => `ST${randomBytes(12).toString('hex').toUpperCase()}`;

const lockOrder = (tx, orderId) => tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;

const buildSessionParams = (order, transactionRef, amount) => {
  const { shippingAddress: address, user, items } = order;
  const callback = (name) => `${env.apiPublicUrl}/api/payments/sslcommerz/${name}`;
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    total_amount: amount.toFixed(2),
    currency: order.currency,
    tran_id: transactionRef,
    success_url: callback('success'),
    fail_url: callback('fail'),
    cancel_url: callback('cancel'),
    ipn_url: callback('ipn'),
    cus_name: address.fullName,
    cus_email: user.email,
    cus_add1: address.line1,
    cus_city: address.city,
    cus_postcode: address.postalCode || '0000',
    cus_country: address.country,
    cus_phone: address.phone,
    shipping_method: 'Courier',
    num_of_item: String(quantity),
    ship_name: address.fullName,
    ship_add1: address.line1,
    ship_city: address.city,
    ship_postcode: address.postalCode || '0000',
    ship_country: address.country,
    product_name: `Sajsub Tech order ${order.orderNumber}`,
    product_category: 'General',
    product_profile: 'physical-goods',
  };
};

// Starts a payment attempt. The amount always comes from the stored order.
export const startOnlinePayment = async (userId, orderId) => {
  const prepared = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findFirst({
      where: { id: orderId, userId },
      include: { items: true, user: { select: { email: true } } },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.paymentMethod !== 'ONLINE') throw new ApiError(409, 'This order is not paid online');
    if (COLLECTED_STATUSES.includes(order.paymentStatus)) throw new ApiError(409, 'This order has already been paid');
    if (order.status !== 'PENDING') throw new ApiError(409, 'This order can no longer be paid');

    const open = await tx.payment.findFirst({ where: { orderId, status: 'PENDING', transactionRef: { not: null } } });
    if (open) {
      // A double click or second tab gets the same payment page rather than a second attempt.
      if (Date.now() - open.createdAt.getTime() < REUSE_SESSION_MS) {
        if (!open.gatewayUrl) throw new ApiError(409, 'This payment is already being started. Please wait a moment.');
        return { gatewayUrl: open.gatewayUrl };
      }
      await tx.payment.update({ where: { id: open.id }, data: { status: 'FAILED', failureReason: 'Replaced by a new attempt' } });
    }

    const attempt = await tx.payment.create({
      data: {
        orderId,
        method: 'ONLINE',
        provider: 'SSLCOMMERZ',
        transactionRef: generateReference(),
        amount: order.totalAmount,
        currency: order.currency,
      },
    });
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'PENDING' } });
    return { attempt, order };
  });

  if (prepared.gatewayUrl) return { gatewayUrl: prepared.gatewayUrl };

  const { attempt, order } = prepared;
  try {
    const { gatewayUrl } = await paymentGateway.createSession(buildSessionParams(order, attempt.transactionRef, attempt.amount));
    await prisma.payment.update({ where: { id: attempt.id }, data: { gatewayUrl } });
    return { gatewayUrl };
  } catch (error) {
    await markPaymentFailed(attempt.transactionRef, 'The payment could not be started');
    throw error;
  }
};

export const markPaymentFailed = (transactionRef, failureReason) =>
  prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { transactionRef } });
    if (!payment) return;
    await lockOrder(tx, payment.orderId);
    // Only an open attempt can fail, so a late failure notice can't undo a verified payment.
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'FAILED', failureReason },
    });
    if (count > 0) await tx.order.updateMany({ where: { id: payment.orderId, paymentStatus: 'PENDING' }, data: { paymentStatus: 'FAILED' } });
  });

// Records a result the provider has confirmed. Safe to call repeatedly for one payment.
export const applyVerifiedPayment = async (transactionRef, verification) => {
  const payment = await prisma.payment.findUnique({ where: { transactionRef } });
  if (!payment) return 'unknown';

  const matches =
    verification.valid &&
    verification.transactionRef === transactionRef &&
    verification.currency === payment.currency &&
    verification.amount !== undefined &&
    new Prisma.Decimal(verification.amount).equals(payment.amount);

  if (!matches) {
    console.error(`Payment ${transactionRef} failed verification against the provider's record`);
    await prisma.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { failureReason: "The provider's record did not match this order" },
    });
    return 'rejected';
  }

  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, payment.orderId);
    const current = await tx.payment.findUnique({ where: { id: payment.id }, include: { order: true } });
    if (COLLECTED_STATUSES.includes(current.status)) return 'already-paid';

    const anotherPaid = await tx.payment.count({
      where: { orderId: payment.orderId, id: { not: payment.id }, status: { in: COLLECTED_STATUSES } },
    });
    const orderClosed = ['CANCELLED', 'REFUNDED'].includes(current.order.status);

    // The money has been taken either way. A second payment or one for a closed order gets flagged for refund.
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        failureReason: null,
        providerTransactionId: verification.bankTransactionId,
        providerResponse: verification.details,
        needsRefund: anotherPaid > 0 || orderClosed,
        riskFlagged: verification.riskFlagged,
      },
    });
    if (anotherPaid > 0) return 'duplicate';

    await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: 'PAID' } });
    // Payments the provider marks as risky wait for an admin to confirm the order.
    if (current.order.status === 'PENDING' && !verification.riskFlagged) {
      await tx.order.update({ where: { id: payment.orderId }, data: { status: 'CONFIRMED' } });
      await tx.orderStatusHistory.create({
        data: { orderId: payment.orderId, status: 'CONFIRMED', note: 'Payment verified' },
      });
    }
    return 'paid';
  });
};

// Asks the provider about a payment directly, for when no notification reached us.
export const refreshPayment = async (payment) => {
  const results = await paymentGateway.queryByTransaction(payment.transactionRef);
  const success = results.find(({ status }) => status === 'VALID' || status === 'VALIDATED');
  if (success) {
    return applyVerifiedPayment(payment.transactionRef, await paymentGateway.validate(success.valId));
  }
  if (results.length > 0 && results.every(({ status }) => FAILED_PROVIDER_STATUSES.has(status))) {
    await markPaymentFailed(payment.transactionRef, 'Reported as failed by the provider');
    return 'failed';
  }
  return 'pending';
};

// Customers and admins can ask for a fresh check. The answer always comes from the provider.
export const refreshOrderPayments = async (orderId) => {
  const open = await prisma.payment.findMany({
    where: { orderId, status: { in: ['PENDING', 'FAILED'] }, transactionRef: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  for (const payment of open) await refreshPayment(payment);
};

export const verifyPaymentById = async (id) => {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (!payment.transactionRef) throw new ApiError(409, 'Only online payments can be checked with the provider');
  const outcome = await refreshPayment(payment);
  return { id, outcome };
};

const callbackReason = { fail: 'Declined at the payment page', cancel: 'Cancelled by the customer' };

// Handles the browser returning from the payment page. Nothing posted here is trusted:
// a success only counts once the provider's validation API confirms it.
export const handleBrowserCallback = async (kind, body) => {
  const { tran_id: transactionRef, val_id: valId } = body;
  const payment = await prisma.payment.findUnique({ where: { transactionRef }, select: { orderId: true, transactionRef: true } });
  if (!payment) return { orderId: null, result: 'unknown' };

  try {
    if (kind === 'success') {
      if (!valId) return { orderId: payment.orderId, result: 'pending' };
      const outcome = await applyVerifiedPayment(transactionRef, await paymentGateway.validate(valId));
      return { orderId: payment.orderId, result: outcome === 'paid' || outcome === 'already-paid' ? 'success' : 'pending' };
    }
    if (paymentGateway.verifySignature(body)) await markPaymentFailed(transactionRef, callbackReason[kind]);
    else await refreshPayment(payment);
  } catch (error) {
    console.error(`Payment callback could not be processed: ${error.message}`);
    return { orderId: payment.orderId, result: 'pending' };
  }
  return { orderId: payment.orderId, result: kind === 'cancel' ? 'cancelled' : 'failed' };
};

// The provider's server-to-server notification.
export const handleIpn = async (body) => {
  if (!paymentGateway.verifySignature(body)) throw new ApiError(400, 'Invalid signature');
  const { tran_id: transactionRef, val_id: valId, status } = body;

  if ((status === 'VALID' || status === 'VALIDATED') && valId) {
    return applyVerifiedPayment(transactionRef, await paymentGateway.validate(valId));
  }
  if (FAILED_PROVIDER_STATUSES.has(status)) {
    await markPaymentFailed(transactionRef, `Reported as ${status} by the provider`);
    return 'failed';
  }
  return 'ignored';
};

// Cancels online orders left unpaid, so their stock goes back on sale. Each is checked with
// the provider first, in case a payment went through but the notification never arrived.
export const expireUnpaidOnlineOrders = async () => {
  const cutoff = new Date(Date.now() - UNPAID_ORDER_LIMIT_MINUTES * 60 * 1000);
  const orders = await prisma.order.findMany({
    where: { paymentMethod: 'ONLINE', status: 'PENDING', paymentStatus: { in: ['PENDING', 'FAILED'] }, placedAt: { lt: cutoff } },
    select: { id: true },
  });

  let expired = 0;
  for (const { id } of orders) {
    try {
      await refreshOrderPayments(id);
      const fresh = await prisma.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true } });
      if (fresh.status === 'PENDING' && !COLLECTED_STATUSES.includes(fresh.paymentStatus)) {
        await updateOrderStatus(id, 'CANCELLED', { note: 'Payment was not completed in time' });
        expired += 1;
      }
    } catch (error) {
      // Left for the next run, so an outage at the provider can't cancel an order that was paid.
      console.error(`Could not expire order ${id}: ${error.message}`);
    }
  }
  return expired;
};
