import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

const tag = `checkouttest-${randomUUID().slice(0, 8)}`;
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

const session = async (email) => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  const send = (method) => (path, data) => agent[method](path).set('X-CSRF-Token', csrfToken).send(data);
  const client = { get: (path) => agent.get(path), post: send('post'), patch: send('patch'), delete: send('delete') };
  await client.post('/api/auth/login', { email, password: PASSWORD });
  return client;
};

const customer = async (name) => {
  const email = `${tag}-${name}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'Test', lastName: 'Buyer' } });
  return { user, email, ...(await session(email)) };
};

const ADDRESS = { fullName: 'Test Buyer', phone: '+1 555 010 1234', line1: '1 Test St', city: 'Testville', country: 'Testland' };
const checkout = (extra) => ({ shippingAddress: ADDRESS, paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: randomUUID(), ...extra });

after(async () => {
  const orderWhere = { user: { email: { startsWith: tag } } };
  await prisma.inventoryTransaction.deleteMany({ where: { product: { slug: { startsWith: tag } } } });
  await prisma.payment.deleteMany({ where: { order: orderWhere } });
  await prisma.orderItem.deleteMany({ where: { order: orderWhere } });
  await prisma.order.deleteMany({ where: orderWhere });
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: tag } });
  await prisma.brand.deleteMany({ where: { slug: tag } });
  await prisma.$disconnect();
});

test('the cart reports subtotal, discount, shipping and total', async () => {
  const buyer = await customer('totals');
  const product = await makeProduct({ price: '100.00', discountPrice: '75.00' });
  const { data } = (await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 })).body;
  assert.equal(data.subtotal, '200.00');
  assert.equal(data.discount, '50.00');
  assert.equal(data.shipping, '0.00');
  assert.equal(data.total, '150.00');
});

test('shipping is decided by the discounted price, not the list price', async () => {
  const threshold = Number((await prisma.siteSetting.findUnique({ where: { key: 'free_shipping_threshold' } })).value);
  const buyer = await customer('shipping');
  const product = await makeProduct({ price: `${threshold + 10}.00`, discountPrice: '1.00' });
  const { data } = (await buyer.post('/api/cart/items', { productId: product.id })).body;
  assert.ok(Number(data.shipping) > 0);
  assert.equal(Number(data.total), 1 + Number(data.shipping));
});

test('the cart persists across logout and login, and across devices', async () => {
  const buyer = await customer('persist');
  const product = await makeProduct();
  await buyer.post('/api/cart/items', { productId: product.id, quantity: 3 });
  await buyer.post('/api/auth/logout');
  assert.equal((await buyer.get('/api/cart')).status, 401);

  const later = await session(buyer.email);
  const { data } = (await later.get('/api/cart')).body;
  assert.equal(data.items[0].productId, product.id);
  assert.equal(data.itemCount, 3);
});

test('quantities are validated against stock, and invalid quantities are refused', async () => {
  const buyer = await customer('qty');
  const product = await makeProduct({ stockQuantity: 3 });
  await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 });
  assert.equal((await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 })).status, 409, 'adding beyond stock');
  for (const quantity of [-1, 0, 1.5, 100]) {
    assert.equal((await buyer.patch(`/api/cart/items/${product.id}`, { quantity })).status, 400, String(quantity));
  }
  assert.equal(await prisma.cartItem.count({ where: { productId: product.id } }), 1);
});

test('items that become unavailable are explained and block checkout', async () => {
  const buyer = await customer('issues');
  const low = await makeProduct({ stockQuantity: 5 });
  const gone = await makeProduct({ stockQuantity: 5 });
  const hidden = await makeProduct({ stockQuantity: 5 });
  for (const { id } of [low, gone, hidden]) await buyer.post('/api/cart/items', { productId: id, quantity: 2 });

  await prisma.product.update({ where: { id: low.id }, data: { stockQuantity: 1 } });
  await prisma.product.update({ where: { id: gone.id }, data: { stockQuantity: 0 } });
  await prisma.product.update({ where: { id: hidden.id }, data: { status: 'DRAFT' } });

  const { items } = (await buyer.get('/api/cart')).body.data;
  const issueOf = (id) => items.find(({ productId }) => productId === id);
  assert.equal(issueOf(low.id).issue, 'NOT_ENOUGH_STOCK');
  assert.equal(issueOf(low.id).stockAvailable, 1);
  assert.equal(issueOf(gone.id).issue, 'OUT_OF_STOCK');
  assert.equal(issueOf(gone.id).stockAvailable, undefined);
  assert.equal(issueOf(hidden.id).issue, 'UNAVAILABLE');

  assert.equal((await buyer.post('/api/orders', checkout())).status, 409);
  assert.equal(await prisma.order.count({ where: { userId: buyer.user.id } }), 0);
  assert.equal((await buyer.delete(`/api/cart/items/${hidden.id}`)).status, 200, 'can still be removed');
});

test('a wishlist item moves to the cart, and stays put if it cannot', async () => {
  const buyer = await customer('move');
  const product = await makeProduct();
  await buyer.post('/api/wishlist/items', { productId: product.id });
  const moved = await buyer.post(`/api/wishlist/items/${product.id}/move-to-cart`);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.wishlist.length, 0);
  assert.equal(moved.body.data.cart.itemCount, 1);
  assert.equal((await buyer.post(`/api/wishlist/items/${product.id}/move-to-cart`)).status, 404);

  const empty = await makeProduct();
  await buyer.post('/api/wishlist/items', { productId: empty.id });
  await prisma.product.update({ where: { id: empty.id }, data: { stockQuantity: 0 } });
  assert.equal((await buyer.post(`/api/wishlist/items/${empty.id}/move-to-cart`)).status, 409);
  assert.equal((await buyer.get('/api/wishlist')).body.data.length, 1);
});

test('addresses: default handling, ownership and validation', async () => {
  const buyer = await customer('addr');
  const other = await customer('addrother');
  assert.equal((await buyer.post('/api/addresses', { ...ADDRESS, city: '' })).status, 400);

  const first = (await buyer.post('/api/addresses', ADDRESS)).body.data;
  assert.equal(first.isDefault, true);
  const second = (await buyer.post('/api/addresses', { ...ADDRESS, city: 'Second', isDefault: true })).body.data;
  assert.equal(second.isDefault, true);
  const list = (await buyer.get('/api/addresses')).body.data;
  assert.deepEqual(list.map(({ id }) => id), [second.id, first.id]);
  assert.equal(list[1].isDefault, false);

  assert.equal((await other.delete(`/api/addresses/${first.id}`)).status, 404);
  assert.equal((await other.get('/api/addresses')).body.data.length, 0);

  await buyer.delete(`/api/addresses/${second.id}`);
  assert.equal((await buyer.get('/api/addresses')).body.data[0].isDefault, true, 'the next becomes default');
});

test('checkout uses a saved address and copies it onto the order', async () => {
  const buyer = await customer('saved');
  const other = await customer('savedother');
  const product = await makeProduct();
  const address = (await buyer.post('/api/addresses', ADDRESS)).body.data;
  await buyer.post('/api/cart/items', { productId: product.id });

  const stolen = await other.post('/api/addresses', ADDRESS);
  const refused = await buyer.post('/api/orders', { paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: randomUUID(), addressId: stolen.body.data.id });
  assert.equal(refused.status, 404);

  const placed = await buyer.post('/api/orders', { paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: randomUUID(), addressId: address.id });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.data.shippingAddress.city, 'Testville');

  await buyer.delete(`/api/addresses/${address.id}`);
  const detail = await buyer.get(`/api/orders/${placed.body.data.id}`);
  assert.equal(detail.body.data.shippingAddress.line1, '1 Test St');
});

test('checkout input is validated, including payment method and client prices', async () => {
  const buyer = await customer('bad');
  const product = await makeProduct();
  await buyer.post('/api/cart/items', { productId: product.id });
  assert.equal((await buyer.post('/api/orders', checkout({ paymentMethod: 'CARD' }))).status, 400);
  assert.equal((await buyer.post('/api/orders', checkout({ idempotencyKey: undefined }))).status, 400);
  assert.equal((await buyer.post('/api/orders', checkout({ total: '1.00' }))).status, 400);
  assert.equal((await buyer.post('/api/orders', checkout({ shippingAddress: undefined }))).status, 400);
  assert.equal((await buyer.post('/api/orders', checkout({ addressId: randomUUID() }))).status, 400, 'both kinds of address');
});

test('a changed price stops checkout instead of charging a different total', async () => {
  const buyer = await customer('price');
  const product = await makeProduct({ price: '100.00' });
  const { total } = (await buyer.post('/api/cart/items', { productId: product.id })).body.data;
  await prisma.product.update({ where: { id: product.id }, data: { price: '150.00' } });

  const res = await buyer.post('/api/orders', checkout({ expectedTotal: total }));
  assert.equal(res.status, 409);
  assert.match(res.body.message, /Prices have changed/);
  assert.equal(await prisma.order.count({ where: { userId: buyer.user.id } }), 0);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity, 10);
});

test('the order records subtotal, discount, shipping and total from the database', async () => {
  const buyer = await customer('record');
  const product = await makeProduct({ price: '100.00', discountPrice: '80.00' });
  await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 });
  const order = (await buyer.post('/api/orders', checkout())).body.data;
  assert.equal(Number(order.subtotalAmount), 200);
  assert.equal(Number(order.discountAmount), 40);
  assert.equal(Number(order.totalAmount), 160 + Number(order.shippingAmount));
  assert.equal(Number(order.items[0].unitPrice), 80);
  assert.equal(Number(order.payments[0].amount), Number(order.totalAmount));
});

test('retrying with the same key returns the same order', async () => {
  const buyer = await customer('retry');
  const product = await makeProduct({ stockQuantity: 10 });
  await buyer.post('/api/cart/items', { productId: product.id });
  const body = checkout();
  const first = await buyer.post('/api/orders', body);
  const second = await buyer.post('/api/orders', body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(await prisma.order.count({ where: { userId: buyer.user.id } }), 1);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity, 9);
});

test('simultaneous checkouts create one order, with the same or different keys', async () => {
  for (const sameKey of [true, false]) {
    const buyer = await customer(`race${sameKey}`);
    const product = await makeProduct({ stockQuantity: 10 });
    await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 });
    const shared = checkout();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => buyer.post('/api/orders', sameKey ? shared : checkout())),
    );
    assert.equal(await prisma.order.count({ where: { userId: buyer.user.id } }), 1, `sameKey=${sameKey}`);
    assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity, 8);
    assert.equal(results.filter(({ status }) => status === 201).length, 1);
    if (sameKey) assert.ok(results.every(({ status }) => status === 200 || status === 201));
    else assert.ok(results.every(({ status }) => status === 201 || status === 400), 'the rest see an empty cart');
  }
});

test('one customer cannot reuse another customer\'s key to read their order', async () => {
  const first = await customer('keya');
  const second = await customer('keyb');
  const product = await makeProduct();
  for (const buyer of [first, second]) await buyer.post('/api/cart/items', { productId: product.id });
  const body = checkout();
  const a = await first.post('/api/orders', body);
  const b = await second.post('/api/orders', body);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.data.id, b.body.data.id);
});
