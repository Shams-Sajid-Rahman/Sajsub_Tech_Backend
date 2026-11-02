import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { placeOrder } from '../src/services/customerOrder.service.js';

const tag = `storetest-${randomUUID().slice(0, 8)}`;
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

const customer = async (name) => {
  const email = `${tag}-${name}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash, firstName: 'Test', lastName: 'Buyer' } });
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  const send = (method) => (path, data) => agent[method](path).set('X-CSRF-Token', csrfToken).send(data);
  await send('post')('/api/auth/login', { email, password: PASSWORD });
  return { user, get: (path) => agent.get(path), post: send('post'), patch: send('patch'), put: send('put'), delete: send('delete') };
};

const ADDRESS = { fullName: 'Test Buyer', phone: '+1 555 010 1234', line1: '1 Test St', city: 'Testville', country: 'Testland' };

after(async () => {
  const userWhere = { user: { email: { startsWith: tag } } };
  await prisma.inventoryTransaction.deleteMany({ where: { product: { slug: { startsWith: tag } } } });
  await prisma.payment.deleteMany({ where: { order: userWhere } });
  await prisma.orderItem.deleteMany({ where: { order: userWhere } });
  await prisma.order.deleteMany({ where: userWhere });
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: tag } });
  await prisma.brand.deleteMany({ where: { slug: tag } });
  await prisma.$disconnect();
});

test('cart, wishlist and orders need a customer login', async () => {
  for (const path of ['/api/cart', '/api/wishlist', '/api/orders']) {
    assert.equal((await request(app).get(path)).status, 401, path);
  }
});

test('the cart calculates prices from the database and rejects prices from the browser', async () => {
  const buyer = await customer('cart');
  const product = await makeProduct({ price: '100.00', discountPrice: '60.00' });

  const added = await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 });
  assert.equal(added.status, 201);
  assert.equal(added.body.data.subtotal, '120.00');
  assert.equal(added.body.data.itemCount, 2);

  const faked = await buyer.post('/api/cart/items', { productId: product.id, quantity: 1, price: '1.00' });
  assert.equal(faked.status, 400);

  const again = await buyer.post('/api/cart/items', { productId: product.id, quantity: 1 });
  assert.equal(again.body.data.items.length, 1, 'no duplicate lines');
  assert.equal(again.body.data.items[0].quantity, 3);

  assert.equal((await buyer.patch(`/api/cart/items/${product.id}`, { quantity: 0 })).status, 400);
  assert.equal((await buyer.patch(`/api/cart/items/${product.id}`, { quantity: 11 })).status, 409);
  const updated = await buyer.patch(`/api/cart/items/${product.id}`, { quantity: 1 });
  assert.equal(updated.body.data.subtotal, '60.00');

  const removed = await buyer.delete(`/api/cart/items/${product.id}`);
  assert.equal(removed.body.data.items.length, 0);
});

test('out-of-stock and unpublished products cannot go in the cart', async () => {
  const buyer = await customer('limits');
  const empty = await makeProduct({ stockQuantity: 0 });
  const draft = await makeProduct({ status: 'DRAFT' });
  assert.equal((await buyer.post('/api/cart/items', { productId: empty.id })).status, 409);
  assert.equal((await buyer.post('/api/cart/items', { productId: draft.id })).status, 404);
  assert.equal((await buyer.post('/api/wishlist/items', { productId: draft.id })).status, 404);
});

test('the wishlist adds, ignores duplicates, and removes', async () => {
  const buyer = await customer('wish');
  const product = await makeProduct();
  await buyer.post('/api/wishlist/items', { productId: product.id });
  const twice = await buyer.post('/api/wishlist/items', { productId: product.id });
  assert.equal(twice.body.data.length, 1);
  assert.equal((await buyer.delete(`/api/wishlist/items/${product.id}`)).body.data.length, 0);
});

test('checkout creates the order, snapshots prices, takes stock and empties the cart', async () => {
  const buyer = await customer('checkout');
  const product = await makeProduct({ price: '30.00', stockQuantity: 5 });
  await buyer.post('/api/cart/items', { productId: product.id, quantity: 2 });

  const bad = await buyer.post('/api/orders', { shippingAddress: { ...ADDRESS, city: '' } });
  assert.equal(bad.status, 400);

  const placed = await buyer.post('/api/orders', { shippingAddress: ADDRESS });
  assert.equal(placed.status, 201);
  const order = placed.body.data;
  assert.equal(order.items[0].unitPrice, '30');
  assert.equal(order.payments[0].method, 'CASH_ON_DELIVERY');
  assert.equal(Number(order.totalAmount), 60 + Number(order.shippingAmount));

  const stored = await prisma.product.findUnique({ where: { id: product.id }, include: { inventoryTransactions: true } });
  assert.equal(stored.stockQuantity, 3);
  assert.equal(stored.inventoryTransactions[0].orderId, order.id);
  assert.equal((await buyer.get('/api/cart')).body.data.items.length, 0);

  await prisma.product.update({ where: { id: product.id }, data: { price: '999.00' } });
  const detail = await buyer.get(`/api/orders/${order.id}`);
  assert.equal(detail.body.data.items[0].unitPrice, '30', 'history keeps the price paid');
  assert.equal((await buyer.get('/api/orders')).body.meta.total, 1);

  assert.equal((await buyer.post('/api/orders', { shippingAddress: ADDRESS })).status, 400, 'empty cart');
});

test('free shipping applies at the threshold', async () => {
  const setting = await prisma.siteSetting.findUnique({ where: { key: 'free_shipping_threshold' } });
  const buyer = await customer('ship');
  const cheap = await makeProduct({ price: '1.00' });
  const pricey = await makeProduct({ price: `${Number(setting.value) + 1}.00` });
  const low = await buyer.post('/api/cart/items', { productId: cheap.id });
  assert.ok(Number(low.body.data.shipping) > 0);
  const high = await buyer.post('/api/cart/items', { productId: pricey.id });
  assert.equal(high.body.data.shipping, '0.00');
});

test('stock problems at checkout leave no order and no stock change', async () => {
  const buyer = await customer('fail');
  const fine = await makeProduct({ stockQuantity: 5 });
  const scarce = await makeProduct({ stockQuantity: 5 });
  await buyer.post('/api/cart/items', { productId: fine.id, quantity: 2 });
  await buyer.post('/api/cart/items', { productId: scarce.id, quantity: 2 });
  await prisma.product.update({ where: { id: scarce.id }, data: { stockQuantity: 1 } });

  const res = await buyer.post('/api/orders', { shippingAddress: ADDRESS });
  assert.equal(res.status, 409);
  assert.equal((await prisma.product.findUnique({ where: { id: fine.id } })).stockQuantity, 5);
  assert.equal(await prisma.order.count({ where: { userId: buyer.user.id } }), 0);
  assert.equal((await buyer.get('/api/cart')).body.data.items.length, 2);
});

test('two customers cannot both buy the last item', async () => {
  const product = await makeProduct({ stockQuantity: 1 });
  const buyers = await Promise.all([customer('race1'), customer('race2')]);
  for (const buyer of buyers) await buyer.post('/api/cart/items', { productId: product.id });
  const results = await Promise.allSettled(buyers.map(({ user }) => placeOrder(user.id, { shippingAddress: ADDRESS })));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity, 0);
});

test('customers see only their own orders, and can cancel only pending ones', async () => {
  const owner = await customer('owner');
  const other = await customer('other');
  const product = await makeProduct({ stockQuantity: 5 });
  await owner.post('/api/cart/items', { productId: product.id });
  const { id } = (await owner.post('/api/orders', { shippingAddress: ADDRESS })).body.data;

  assert.equal((await other.get(`/api/orders/${id}`)).status, 404);
  assert.equal((await other.post(`/api/orders/${id}/cancel`)).status, 404);

  assert.equal((await owner.post(`/api/orders/${id}/cancel`)).status, 200);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity, 5);
  assert.equal((await owner.post(`/api/orders/${id}/cancel`)).status, 409);
});

test('only customers who received a product can review it, and ratings update', async () => {
  const buyer = await customer('review');
  const product = await makeProduct({ stockQuantity: 5 });
  const path = `/api/products/${product.slug}/reviews`;

  assert.equal((await request(app).get(path)).status, 200);
  assert.equal((await buyer.put(path, { rating: 5 })).status, 403);

  await buyer.post('/api/cart/items', { productId: product.id });
  const { id } = (await buyer.post('/api/orders', { shippingAddress: ADDRESS })).body.data;
  await prisma.order.update({ where: { id }, data: { status: 'DELIVERED' } });

  assert.equal((await buyer.put(path, { rating: 9 })).status, 400);
  assert.equal((await buyer.put(path, { rating: 4, comment: 'Good' })).status, 200);
  assert.equal((await buyer.put(path, { rating: 2 })).status, 200);

  const list = await request(app).get(path);
  assert.equal(list.body.meta.total, 1);
  assert.equal(list.body.data[0].author, 'Test B.');
  assert.doesNotMatch(JSON.stringify(list.body), /example\.com/);
  const stored = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(stored.ratingAverage.toString(), '2');
  assert.equal(stored.ratingCount, 1);
});

test('listing filters by availability, and related products exclude the product itself', async () => {
  const inStock = await makeProduct({ stockQuantity: 2 });
  await makeProduct({ stockQuantity: 0 });
  const unavailable = await request(app).get('/api/products').query({ brand: tag, inStock: false, limit: 100 });
  assert.ok(unavailable.body.data.every((product) => product.inStock === false));
  const available = await request(app).get('/api/products').query({ brand: tag, inStock: true, limit: 100 });
  assert.ok(available.body.data.every((product) => product.inStock === true));

  const related = await request(app).get(`/api/products/${inStock.slug}/related`);
  assert.equal(related.status, 200);
  assert.ok(related.body.data.length > 0);
  assert.ok(related.body.data.every(({ id }) => id !== inStock.id));
});

test('site content only exposes public settings', async () => {
  const key = `private_${tag.replace(/[^a-z0-9]/g, '_')}`;
  await prisma.siteSetting.create({ data: { key, value: 'secret', isPublic: false } });
  const res = await request(app).get('/api/site');
  await prisma.siteSetting.delete({ where: { key } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.settings[key], undefined);
  assert.ok(Array.isArray(res.body.data.banners));
});

test('the contact form validates input and accepts valid messages', async () => {
  const visitor = request.agent(app);
  const { csrfToken } = (await visitor.get('/api/auth/csrf-token')).body.data;
  const post = (data) => visitor.post('/api/contact').set('X-CSRF-Token', csrfToken).send(data);
  assert.equal((await post({ name: 'A', email: 'nope', subject: 'S', message: 'M' })).status, 400);
  const original = console.log;
  console.log = () => {};
  const res = await post({ name: 'A', email: 'a@example.com', subject: 'S', message: 'M' });
  console.log = original;
  assert.equal(res.status, 200);
});
