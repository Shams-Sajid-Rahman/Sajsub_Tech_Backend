import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/prisma.js';
import { expireUnpaidOnlineOrders } from '../src/services/payments/payment.service.js';
import { paymentGateway } from '../src/services/payments/sslcommerz.gateway.js';

// The provider is replaced with this fake, so no real payment calls are made.
const realGateway = { ...paymentGateway };
let validations;
let queries;
let sessionsCreated;
let validateCalls;
let lastSession;

const fakeGateway = () => {
  paymentGateway.isConfigured = () => true;
  paymentGateway.createSession = async (params) => {
    sessionsCreated += 1;
    lastSession = params;
    return { gatewayUrl: `https://gateway.example/${params.tran_id}` };
  };
  paymentGateway.validate = async (valId) => {
    validateCalls += 1;
    const result = validations[valId];
    if (!result) return { valid: false };
    return result;
  };
  paymentGateway.queryByTransaction = async (ref) => queries[ref] ?? [];
  paymentGateway.verifySignature = ({ verify_sign: sign }) => sign === 'good';
};

beforeEach(() => {
  validations = {};
  queries = {};
  sessionsCreated = 0;
  validateCalls = 0;
  lastSession = null;
  fakeGateway();
});

const verified = (transactionRef, amount, extra = {}) => ({
  valid: true,
  transactionRef,
  amount: String(amount),
  currency: 'BDT',
  bankTransactionId: `BANK-${randomUUID()}`,
  riskFlagged: false,
  details: { status: 'VALID', tran_id: transactionRef },
  ...extra,
});

const tag = `paytest-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'Correct-horse-1';
const passwordHash = await bcrypt.hash(PASSWORD, 4);
const category = await prisma.category.create({ data: { name: tag, slug: tag } });
const brand = await prisma.brand.create({ data: { name: tag, slug: tag } });
let counter = 0;
const makeProduct = (fields) => {
  counter += 1;
  const name = `${tag}-${counter}`;
  return prisma.product.create({
    data: { name, slug: name, sku: name, price: '100.00', stockQuantity: 10, status: 'PUBLISHED', categoryId: category.id, brandId: brand.id, ...fields },
  });
};

const client = async (loginPath, email) => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  const send = (method) => (path, data) => agent[method](path).set('X-CSRF-Token', csrfToken).send(data);
  const session = { get: (path) => agent.get(path), post: send('post'), patch: send('patch') };
  const login = await session.post(loginPath, { email, password: PASSWORD });
  assert.equal(login.status, 200);
  return session;
};

const makeUser = (name, role = 'CUSTOMER') =>
  prisma.user.create({ data: { email: `${tag}-${name}@example.com`, passwordHash, firstName: 'Test', lastName: name, role } });

const adminUser = await makeUser('admin', 'ADMIN');
const admin = await client('/api/admin/auth/login', adminUser.email);
const customerUser = await makeUser('buyer');
const buyer = await client('/api/auth/login', customerUser.email);
const otherUser = await makeUser('other');
const other = await client('/api/auth/login', otherUser.email);

const ADDRESS = { fullName: 'Test Buyer', phone: '+1 555 010 1234', line1: '1 Test St', city: 'Dhaka', country: 'Bangladesh' };

const placeOrder = async (paymentMethod, { price = '100.00', quantity = 1, stockQuantity = 10 } = {}) => {
  const product = await makeProduct({ price, stockQuantity });
  await buyer.post('/api/cart/items', { productId: product.id, quantity });
  const res = await buyer.post('/api/orders', { shippingAddress: ADDRESS, paymentMethod, idempotencyKey: randomUUID() });
  assert.equal(res.status, 201);
  return { order: res.body.data, product };
};

const startPayment = async (orderId) => {
  const res = await buyer.post(`/api/orders/${orderId}/payments`);
  assert.equal(res.status, 201);
  const payment = await prisma.payment.findFirst({ where: { orderId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
  return { gatewayUrl: res.body.data.gatewayUrl, payment };
};

const orderState = (id) => prisma.order.findUnique({ where: { id }, include: { payments: true, statusHistory: true } });
const stockOf = async ({ id }) => (await prisma.product.findUnique({ where: { id } })).stockQuantity;
const callback = (name, fields) => request(app).post(`/api/payments/sslcommerz/${name}`).type('form').send(fields);

after(async () => {
  Object.assign(paymentGateway, realGateway);
  const orderWhere = { user: { email: { startsWith: tag } } };
  await prisma.refund.deleteMany({ where: { order: orderWhere } });
  await prisma.inventoryTransaction.deleteMany({ where: { product: { slug: { startsWith: tag } } } });
  await prisma.payment.deleteMany({ where: { order: orderWhere } });
  await prisma.orderItem.deleteMany({ where: { order: orderWhere } });
  await prisma.order.deleteMany({ where: orderWhere });
  await prisma.auditLog.deleteMany({ where: { actorId: adminUser.id } });
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: tag } });
  await prisma.brand.deleteMany({ where: { slug: tag } });
  await prisma.$disconnect();
});

// ---------- Starting a payment ----------

test('online orders are refused when the provider is not configured', async () => {
  paymentGateway.isConfigured = () => false;
  const product = await makeProduct();
  await buyer.post('/api/cart/items', { productId: product.id });
  const res = await buyer.post('/api/orders', { shippingAddress: ADDRESS, paymentMethod: 'ONLINE', idempotencyKey: randomUUID() });
  assert.equal(res.status, 503);
  assert.equal((await request(app).get('/api/site')).body.data.payments.online, false);
  await buyer.post('/api/cart/items', { productId: product.id }).then(() => prisma.cartItem.deleteMany({ where: { productId: product.id } }));
});

test('placing an online order holds stock, and nothing is paid yet', async () => {
  const { order, product } = await placeOrder('ONLINE', { quantity: 2 });
  assert.equal(order.paymentStatus, 'PENDING');
  assert.equal(order.status, 'PENDING');
  assert.equal(order.payments.length, 0);
  assert.equal(await stockOf(product), 8);
});

test('starting a payment sends the stored total, whatever the browser sends', async () => {
  const { order } = await placeOrder('ONLINE', { price: '100.00', quantity: 2 });
  const { gatewayUrl, payment } = await startPayment(order.id);
  assert.match(gatewayUrl, /gateway\.example/);
  assert.equal(lastSession.total_amount, Number(order.totalAmount).toFixed(2));
  assert.equal(lastSession.tran_id, payment.transactionRef);
  assert.equal(lastSession.cus_postcode, '0000', 'the provider requires a postcode');
  assert.match(lastSession.ipn_url, /\/api\/payments\/sslcommerz\/ipn$/);
});

test('a double click reuses the same attempt', async () => {
  const { order } = await placeOrder('ONLINE');
  const first = await startPayment(order.id);
  const second = await startPayment(order.id);
  assert.equal(first.gatewayUrl, second.gatewayUrl);
  assert.equal(sessionsCreated, 1);
  assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 1);
});

test('only the owner can pay, and cash or paid orders cannot start a payment', async () => {
  const { order } = await placeOrder('ONLINE');
  assert.equal((await other.post(`/api/orders/${order.id}/payments`)).status, 404);
  assert.equal((await other.post(`/api/orders/${order.id}/payments/verify`)).status, 404);

  const cash = await placeOrder('CASH_ON_DELIVERY');
  assert.equal((await buyer.post(`/api/orders/${cash.order.id}/payments`)).status, 409);

  const { payment } = await startPayment(order.id);
  validations.v1 = verified(payment.transactionRef, payment.amount);
  await callback('success', { tran_id: payment.transactionRef, val_id: 'v1' });
  assert.equal((await buyer.post(`/api/orders/${order.id}/payments`)).status, 409);
});

test('a provider failure when starting leaves the order ready to try again', async () => {
  const { order } = await placeOrder('ONLINE');
  paymentGateway.createSession = async () => {
    const error = new Error('down');
    error.status = 502;
    throw error;
  };
  assert.notEqual((await buyer.post(`/api/orders/${order.id}/payments`)).status, 201);
  const state = await orderState(order.id);
  assert.equal(state.payments[0].status, 'FAILED');
  assert.equal(state.paymentStatus, 'FAILED');
  fakeGateway();
  await startPayment(order.id);
  assert.equal((await orderState(order.id)).paymentStatus, 'PENDING');
});

// ---------- Verification: the rule that matters most ----------

test('a forged success callback cannot mark an order paid', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);

  // No val_id, an unknown val_id, and a forged status. The browser is still sent back.
  for (const fields of [
    { tran_id: payment.transactionRef },
    { tran_id: payment.transactionRef, val_id: 'made-up', status: 'VALID', amount: payment.amount.toString() },
  ]) {
    const res = await callback('success', fields);
    assert.equal(res.status, 303);
    assert.match(res.headers.location, /payment=pending/);
  }
  const state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'PENDING');
  assert.equal(state.payments[0].status, 'PENDING');
  assert.equal(state.status, 'PENDING');
});

test('a validated payment for a different amount, currency or reference is rejected', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.wrongAmount = verified(payment.transactionRef, '1.00');
  validations.wrongCurrency = verified(payment.transactionRef, payment.amount, { currency: 'USD' });
  validations.wrongRef = verified('ST-SOMEONE-ELSE', payment.amount);
  for (const valId of ['wrongAmount', 'wrongCurrency', 'wrongRef']) {
    await callback('success', { tran_id: payment.transactionRef, val_id: valId });
    assert.equal((await orderState(order.id)).paymentStatus, 'PENDING', valId);
  }
});

test('a verified payment marks the order paid, confirms it, and stores the references', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.ok = verified(payment.transactionRef, payment.amount, { bankTransactionId: `B-${tag}` });

  const res = await callback('success', { tran_id: payment.transactionRef, val_id: 'ok' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `${env.clientUrl}/orders/${order.id}?payment=success`);

  const state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'PAID');
  assert.equal(state.status, 'CONFIRMED');
  assert.equal(state.payments[0].status, 'PAID');
  assert.equal(state.payments[0].providerTransactionId, `B-${tag}`);
  assert.ok(state.payments[0].paidAt);
  assert.ok(state.statusHistory.some(({ status }) => status === 'CONFIRMED'));
  assert.doesNotMatch(JSON.stringify((await buyer.get(`/api/orders/${order.id}`)).body), /providerResponse|gatewayUrl/);
});

test('repeated notifications change nothing the second time', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.ok = verified(payment.transactionRef, payment.amount);
  const ipn = { tran_id: payment.transactionRef, val_id: 'ok', status: 'VALID', verify_sign: 'good', verify_key: 'status' };

  const results = await Promise.all([
    callback('ipn', ipn),
    callback('ipn', ipn),
    callback('success', { tran_id: payment.transactionRef, val_id: 'ok' }),
  ]);
  assert.ok(results.every(({ status }) => status === 200 || status === 303));
  const state = await orderState(order.id);
  assert.equal(state.payments.length, 1);
  assert.equal(state.payments[0].needsRefund, false);
  assert.equal(state.statusHistory.filter(({ status }) => status === 'CONFIRMED').length, 1);
});

test('a notification with a bad signature is refused before anything happens', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.ok = verified(payment.transactionRef, payment.amount);
  const res = await callback('ipn', { tran_id: payment.transactionRef, val_id: 'ok', status: 'VALID', verify_sign: 'bad', verify_key: 'status' });
  assert.equal(res.status, 400);
  assert.equal(validateCalls, 0);
  assert.equal((await orderState(order.id)).paymentStatus, 'PENDING');
});

test('a valid notification still has to pass the provider check', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  const res = await callback('ipn', { tran_id: payment.transactionRef, val_id: 'not-validated', status: 'VALID', verify_sign: 'good', verify_key: 'status' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.outcome, 'rejected');
  assert.equal((await orderState(order.id)).paymentStatus, 'PENDING');
});

test('risky payments are recorded but wait for an admin to confirm', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.ok = verified(payment.transactionRef, payment.amount, { riskFlagged: true });
  await callback('success', { tran_id: payment.transactionRef, val_id: 'ok' });
  const state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'PAID');
  assert.equal(state.status, 'PENDING');
  assert.equal(state.payments[0].riskFlagged, true);
});

// ---------- Failure scenarios ----------

test('signed failure and cancel callbacks fail the attempt, and the customer can retry', async () => {
  const { order, product } = await placeOrder('ONLINE');
  const stock = await stockOf(product);
  const first = await startPayment(order.id);

  const res = await callback('cancel', { tran_id: first.payment.transactionRef, verify_sign: 'good', verify_key: 'status' });
  assert.match(res.headers.location, /payment=cancelled/);
  let state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'FAILED');
  assert.equal(state.status, 'PENDING', 'the order stays open for another try');
  assert.equal(await stockOf(product), stock, 'stock stays held during retries');

  const second = await startPayment(order.id);
  assert.notEqual(second.payment.transactionRef, first.payment.transactionRef);
  validations.ok = verified(second.payment.transactionRef, second.payment.amount);
  await callback('success', { tran_id: second.payment.transactionRef, val_id: 'ok' });
  state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'PAID');
  assert.equal(state.payments.length, 2);
});

test('an unsigned failure callback only counts if the provider agrees', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  await callback('fail', { tran_id: payment.transactionRef });
  assert.equal((await orderState(order.id)).payments[0].status, 'PENDING');

  queries[payment.transactionRef] = [{ status: 'FAILED' }];
  await callback('fail', { tran_id: payment.transactionRef });
  assert.equal((await orderState(order.id)).payments[0].status, 'FAILED');
});

test('a late failure notice cannot undo a verified payment', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.ok = verified(payment.transactionRef, payment.amount);
  await callback('success', { tran_id: payment.transactionRef, val_id: 'ok' });
  await callback('fail', { tran_id: payment.transactionRef, verify_sign: 'good', verify_key: 'status' });
  const state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'PAID');
  assert.equal(state.payments[0].status, 'PAID');
});

test('an unknown reference is ignored safely', async () => {
  const res = await callback('success', { tran_id: 'ST-NOPE', val_id: 'x' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `${env.clientUrl}/orders`);
  assert.equal((await callback('success', {})).status, 400);
});

test('if the provider is unreachable, the customer can check again later', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  paymentGateway.validate = async () => {
    throw new Error('network down');
  };
  const originalError = console.error;
  console.error = () => {};
  const res = await callback('success', { tran_id: payment.transactionRef, val_id: 'ok' });
  console.error = originalError;
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /payment=pending/);
  assert.equal((await orderState(order.id)).paymentStatus, 'PENDING');

  fakeGateway();
  validations.ok = verified(payment.transactionRef, payment.amount);
  queries[payment.transactionRef] = [{ status: 'VALID', valId: 'ok' }];
  const checked = await buyer.post(`/api/orders/${order.id}/payments/verify`);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.data.paymentStatus, 'PAID');
});

test('paying twice records both, and flags the second for refund', async () => {
  const { order } = await placeOrder('ONLINE');
  const first = await startPayment(order.id);
  await prisma.payment.update({ where: { id: first.payment.id }, data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } });
  const second = await startPayment(order.id);
  assert.equal((await prisma.payment.findUnique({ where: { id: first.payment.id } })).status, 'FAILED');

  validations.a = verified(second.payment.transactionRef, second.payment.amount);
  validations.b = verified(first.payment.transactionRef, first.payment.amount);
  await callback('success', { tran_id: second.payment.transactionRef, val_id: 'a' });
  await callback('success', { tran_id: first.payment.transactionRef, val_id: 'b' });

  const state = await orderState(order.id);
  const flagged = state.payments.filter(({ needsRefund }) => needsRefund);
  assert.equal(state.payments.filter(({ status }) => status === 'PAID').length, 2);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, first.payment.id);

  const refund = await admin.post(`/api/admin/payments/${flagged[0].id}/refunds`, { reason: 'Paid twice' });
  assert.equal(refund.status, 201);
  const after = await orderState(order.id);
  assert.equal(after.status, 'CONFIRMED', 'the real order carries on');
  assert.equal(after.paymentStatus, 'PAID');
});

test('unpaid online orders expire and release stock, but paid ones found at the provider are kept', async () => {
  const unpaid = await placeOrder('ONLINE', { stockQuantity: 5 });
  const paidLate = await placeOrder('ONLINE', { stockQuantity: 5 });
  const notDue = await placeOrder('ONLINE', { stockQuantity: 5 });
  const cash = await placeOrder('CASH_ON_DELIVERY', { stockQuantity: 5 });
  const late = await startPayment(paidLate.order.id);
  queries[late.payment.transactionRef] = [{ status: 'VALID', valId: 'late' }];
  validations.late = verified(late.payment.transactionRef, late.payment.amount);

  const old = new Date(Date.now() - 31 * 60 * 1000);
  for (const { order } of [unpaid, paidLate, cash]) {
    await prisma.order.update({ where: { id: order.id }, data: { placedAt: old } });
  }
  assert.ok((await expireUnpaidOnlineOrders()) >= 1);

  assert.equal((await orderState(unpaid.order.id)).status, 'CANCELLED');
  assert.equal(await stockOf(unpaid.product), 5);
  assert.equal((await orderState(paidLate.order.id)).status, 'CONFIRMED');
  assert.equal((await orderState(notDue.order.id)).status, 'PENDING');
  assert.equal((await orderState(cash.order.id)).status, 'PENDING');
  assert.equal(await stockOf(cash.product), 4);
});

test('a provider outage never cancels an order during expiry', async () => {
  const { order } = await placeOrder('ONLINE');
  await startPayment(order.id);
  await prisma.order.update({ where: { id: order.id }, data: { placedAt: new Date(Date.now() - 31 * 60 * 1000) } });
  paymentGateway.queryByTransaction = async () => {
    throw new Error('down');
  };
  const original = console.error;
  console.error = () => {};
  await expireUnpaidOnlineOrders();
  console.error = original;
  assert.equal((await orderState(order.id)).status, 'PENDING');
});

test('money arriving after an order was cancelled is recorded and flagged for refund', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  assert.equal((await buyer.post(`/api/orders/${order.id}/cancel`)).status, 200);
  assert.equal((await orderState(order.id)).payments[0].status, 'FAILED');

  validations.ok = verified(payment.transactionRef, payment.amount);
  await callback('success', { tran_id: payment.transactionRef, val_id: 'ok' });
  const state = await orderState(order.id);
  assert.equal(state.status, 'CANCELLED');
  assert.equal(state.paymentStatus, 'PAID');
  assert.equal(state.payments[0].needsRefund, true);
  assert.equal((await admin.get('/api/admin/payments').query({ needsRefund: true, search: order.orderNumber })).body.meta.total, 1);
});

// ---------- Admin rules ----------

test('admins cannot mark online payments paid, and must not ship unpaid online orders', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  assert.equal((await admin.patch(`/api/admin/payments/${payment.id}/status`, { status: 'PAID' })).status, 409);
  assert.equal((await admin.patch(`/api/admin/orders/${order.id}/status`, { status: 'CONFIRMED' })).status, 409);
  assert.equal((await orderState(order.id)).paymentStatus, 'PENDING');
});

test('admins can ask the provider to re-check a payment', async () => {
  const { order } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  queries[payment.transactionRef] = [{ status: 'VALID', valId: 'ok' }];
  validations.ok = verified(payment.transactionRef, payment.amount);
  const res = await admin.post(`/api/admin/payments/${payment.id}/verify`);
  assert.equal(res.body.data.outcome, 'paid');
  assert.equal((await orderState(order.id)).paymentStatus, 'PAID');

  const cash = await placeOrder('CASH_ON_DELIVERY');
  assert.equal((await admin.post(`/api/admin/payments/${cash.order.payments[0].id}/verify`)).status, 409);
});

test('status changes are recorded in the tracking history, with tracking details', async () => {
  const { order } = await placeOrder('CASH_ON_DELIVERY');
  const set = (body) => admin.patch(`/api/admin/orders/${order.id}/status`, body);
  await set({ status: 'CONFIRMED' });
  await set({ status: 'PROCESSING' });
  assert.equal((await set({ status: 'SHIPPED', trackingNumber: 'TRK123', carrier: 'Courier Co' })).status, 200);
  assert.equal((await set({ status: 'REFUNDED' })).status, 409, 'only a refund can do this');
  await set({ status: 'DELIVERED' });

  const detail = (await buyer.get(`/api/orders/${order.id}`)).body.data;
  assert.equal(detail.trackingNumber, 'TRK123');
  assert.deepEqual(detail.statusHistory.map(({ status }) => status), ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']);
  assert.equal(JSON.stringify(detail.statusHistory).includes(adminUser.email), false);

  const adminView = (await admin.get(`/api/admin/orders/${order.id}`)).body.data;
  assert.equal(adminView.statusHistory[1].changedBy.email, adminUser.email);
  assert.equal(adminView.user.email, customerUser.email);
  assert.equal(adminView.items.length, 1);
});

test('customers can cancel before processing, but not after', async () => {
  const pending = await placeOrder('CASH_ON_DELIVERY');
  assert.equal((await buyer.post(`/api/orders/${pending.order.id}/cancel`)).status, 200);
  const state = await orderState(pending.order.id);
  assert.equal(state.paymentStatus, 'FAILED');
  assert.equal(await stockOf(pending.product), 10);

  const confirmed = await placeOrder('CASH_ON_DELIVERY');
  await admin.patch(`/api/admin/orders/${confirmed.order.id}/status`, { status: 'CONFIRMED' });
  assert.equal((await buyer.post(`/api/orders/${confirmed.order.id}/cancel`)).status, 200);

  const processing = await placeOrder('CASH_ON_DELIVERY');
  await admin.patch(`/api/admin/orders/${processing.order.id}/status`, { status: 'CONFIRMED' });
  await admin.patch(`/api/admin/orders/${processing.order.id}/status`, { status: 'PROCESSING' });
  assert.equal((await buyer.post(`/api/orders/${processing.order.id}/cancel`)).status, 409);
});

const deliverCashOrder = async (options) => {
  const placed = await placeOrder('CASH_ON_DELIVERY', options);
  for (const status of ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']) {
    await admin.patch(`/api/admin/orders/${placed.order.id}/status`, { status });
  }
  await admin.patch(`/api/admin/payments/${placed.order.payments[0].id}/status`, { status: 'PAID' });
  return placed;
};

test('refunds: partial then full, with limits, history and a closed order at the end', async () => {
  const { order, product } = await deliverCashOrder({ price: '100.00', quantity: 2, stockQuantity: 5 });
  const paymentId = order.payments[0].id;
  const refund = (body) => admin.post(`/api/admin/payments/${paymentId}/refunds`, body);
  const total = Number(order.totalAmount);

  assert.equal((await refund({ amount: '50.00' })).status, 400, 'reason is required');
  assert.equal((await refund({ amount: '0.00', reason: 'x' })).status, 400);
  assert.equal((await refund({ amount: String(total + 1), reason: 'Too much' })).status, 400);

  assert.equal((await refund({ amount: '50.00', reason: 'Damaged box', reference: 'REF-1' })).status, 201);
  let state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'PARTIALLY_REFUNDED');
  assert.equal(state.status, 'DELIVERED');
  assert.equal(await stockOf(product), 3);

  assert.equal((await refund({ reason: 'Returned', restock: true })).status, 201);
  state = await orderState(order.id);
  assert.equal(state.paymentStatus, 'REFUNDED');
  assert.equal(state.status, 'REFUNDED');
  assert.equal(Number(state.payments[0].refundedAmount), total);
  assert.equal(await stockOf(product), 5, 'returned goods went back on sale');
  assert.equal((await refund({ reason: 'Again' })).status, 409, 'nothing left to refund');

  const seen = (await buyer.get(`/api/orders/${order.id}`)).body.data;
  assert.equal(seen.refunds.length, 2);
  assert.equal(JSON.stringify(seen.refunds).includes('Damaged box'), false);
});

test('refunds are refused until the order is cancelled or delivered', async () => {
  const { order } = await placeOrder('CASH_ON_DELIVERY');
  const paymentId = order.payments[0].id;
  assert.equal((await admin.post(`/api/admin/payments/${paymentId}/refunds`, { reason: 'x' })).status, 409, 'nothing collected');
  await admin.patch(`/api/admin/payments/${paymentId}/status`, { status: 'PAID' });
  assert.equal((await admin.post(`/api/admin/payments/${paymentId}/refunds`, { reason: 'x' })).status, 409, 'still in progress');
});

test('cancelling a paid order flags the payment, and the refund closes it', async () => {
  const { order, product } = await placeOrder('ONLINE');
  const { payment } = await startPayment(order.id);
  validations.ok = verified(payment.transactionRef, payment.amount);
  await callback('success', { tran_id: payment.transactionRef, val_id: 'ok' });
  await buyer.post(`/api/orders/${order.id}/cancel`);

  let state = await orderState(order.id);
  assert.equal(state.status, 'CANCELLED');
  assert.equal(state.paymentStatus, 'PAID', 'the money has not been returned yet');
  assert.equal(state.payments[0].needsRefund, true);
  assert.equal(await stockOf(product), 10);

  await admin.post(`/api/admin/payments/${payment.id}/refunds`, { reason: 'Customer cancelled', restock: true });
  state = await orderState(order.id);
  assert.equal(state.status, 'REFUNDED');
  assert.equal(state.payments[0].needsRefund, false);
  assert.equal(await stockOf(product), 10, 'stock is not restored twice');
});

test('revenue subtracts refunds and leaves out money waiting to be refunded', async () => {
  const revenue = async () => Number((await admin.get('/api/admin/stats')).body.data.totals.totalRevenue);
  const before = await revenue();
  const { order } = await deliverCashOrder({ price: '100.00' });
  const total = Number(order.totalAmount);
  assert.equal(await revenue(), before + total);
  await admin.post(`/api/admin/payments/${order.payments[0].id}/refunds`, { amount: '30.00', reason: 'Partial' });
  assert.equal(await revenue(), before + total - 30);
});

test('customers cannot reach refunds or provider checks', async () => {
  const { order } = await placeOrder('CASH_ON_DELIVERY');
  const paymentId = order.payments[0].id;
  assert.equal((await buyer.post(`/api/admin/payments/${paymentId}/refunds`, { reason: 'x' })).status, 401);
  assert.equal((await buyer.post(`/api/admin/payments/${paymentId}/verify`)).status, 401);
});

// ---------- The real provider client, with the network replaced ----------

test('the provider client sends the right requests and reads the replies', async () => {
  Object.assign(paymentGateway, realGateway);
  const originalFetch = globalThis.fetch;
  const originalId = env.sslcommerz.storeId;
  const originalPassword = env.sslcommerz.storePassword;
  env.sslcommerz.storeId = 'store1';
  env.sslcommerz.storePassword = 'secret-password';
  const calls = [];
  const replies = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { json: async () => replies.shift() };
  };
  try {
    assert.equal(paymentGateway.isConfigured(), true);

    replies.push({ status: 'SUCCESS', GatewayPageURL: 'https://sandbox.sslcommerz.com/pay' });
    const session = await paymentGateway.createSession({ tran_id: 'T1', total_amount: '10.00' });
    assert.equal(session.gatewayUrl, 'https://sandbox.sslcommerz.com/pay');
    assert.match(calls[0].url, /^https:\/\/sandbox\.sslcommerz\.com\/gwprocess\/v4\/api\.php$/);
    assert.equal(calls[0].options.body.get('store_id'), 'store1');

    replies.push({ status: 'FAILED', failedreason: 'bad store' });
    const originalError = console.error;
    console.error = () => {};
    await assert.rejects(paymentGateway.createSession({}), { status: 502 });
    console.error = originalError;

    replies.push({
      status: 'VALID', tran_id: 'T1', amount: '1200.00', currency: 'BDT', currency_type: 'USD', currency_amount: '10.00',
      bank_tran_id: 'B1', risk_level: '1', card_no: '4111XXXXXXXX1111',
    });
    const validation = await paymentGateway.validate('V1');
    assert.match(calls[2].url, /validationserverAPI\.php\?.*val_id=V1/);
    assert.equal(validation.valid, true);
    assert.equal(validation.amount, '10.00', 'compares the amount we sent, not the converted one');
    assert.equal(validation.currency, 'USD');
    assert.equal(validation.riskFlagged, true);
    assert.equal(validation.details.card_no, undefined, 'card details are not stored');

    replies.push({ status: 'INVALID_TRANSACTION' });
    assert.equal((await paymentGateway.validate('nope')).valid, false);

    replies.push({ APIConnect: 'DONE', element: [{ status: 'VALID', val_id: 'V1' }] });
    assert.deepEqual(await paymentGateway.queryByTransaction('T1'), [{ status: 'VALID', valId: 'V1' }]);
    replies.push({ APIConnect: 'FAILED' });
    await assert.rejects(paymentGateway.queryByTransaction('T1'), { status: 502 });

    globalThis.fetch = async () => {
      throw new Error('secret-password in a network error');
    };
    await assert.rejects(paymentGateway.validate('V1'), (error) => error.status === 502 && !error.message.includes('secret'));
  } finally {
    globalThis.fetch = originalFetch;
    env.sslcommerz.storeId = originalId;
    env.sslcommerz.storePassword = originalPassword;
  }
});

test('the signature check accepts a correct signature and refuses tampering', () => {
  Object.assign(paymentGateway, realGateway);
  const original = env.sslcommerz.storePassword;
  env.sslcommerz.storePassword = 'secret-password';
  const md5 = (text) => createHash('md5').update(text).digest('hex');
  const fields = { tran_id: 'T1', status: 'VALID', amount: '10.00' };
  const text = `amount=10.00&status=VALID&store_passwd=${md5('secret-password')}&tran_id=T1`;
  const signed = { ...fields, verify_key: 'tran_id,status,amount', verify_sign: md5(text) };
  try {
    assert.equal(paymentGateway.verifySignature(signed), true);
    assert.equal(paymentGateway.verifySignature({ ...signed, amount: '1.00' }), false);
    assert.equal(paymentGateway.verifySignature({ ...signed, verify_sign: 'x' }), false);
    assert.equal(paymentGateway.verifySignature(fields), false);
  } finally {
    env.sslcommerz.storePassword = original;
  }
});
