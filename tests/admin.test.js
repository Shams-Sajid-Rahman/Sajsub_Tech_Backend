import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { adjustStock } from '../src/services/inventory.service.js';

const tag = `admintest-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'Correct-horse-1';
const passwordHash = await bcrypt.hash(PASSWORD, 4);
const makeUser = (name, role) =>
  prisma.user.create({
    data: { email: `${tag}-${name}@example.com`, passwordHash, firstName: 'Test', lastName: name, role },
  });

const clientFor = async (loginPath, email) => {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/auth/csrf-token');
  const send = (method) => (path, data) => agent[method](path).set('X-CSRF-Token', body.data.csrfToken).send(data);
  const client = { get: (path) => agent.get(path), post: send('post'), patch: send('patch'), put: send('put'), delete: send('delete') };
  const login = await client.post(loginPath, { email, password: PASSWORD });
  assert.equal(login.status, 200);
  return client;
};

const adminUser = await makeUser('admin', 'ADMIN');
const customer = await makeUser('customer', 'CUSTOMER');
const admin = await clientFor('/api/admin/auth/login', adminUser.email);
const customerClient = await clientFor('/api/auth/login', customer.email);

const category = (await admin.post('/api/admin/categories', { name: `${tag} Category` })).body.data;
const brand = (await admin.post('/api/admin/brands', { name: `${tag} Brand` })).body.data;

const newProduct = (suffix, extra = {}) =>
  admin.post('/api/admin/products', {
    name: `${tag} ${suffix}`,
    sku: `${tag}-${suffix}`,
    price: '100.00',
    categoryId: category.id,
    brandId: brand.id,
    ...extra,
  });

const makeOrder = async (suffix, productId, quantity) => {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${tag}-${suffix}`.slice(0, 32),
      userId: customer.id,
      subtotalAmount: '100.00',
      totalAmount: '100.00',
      shippingAddress: { city: 'Test' },
      payments: { create: { method: 'CASH_ON_DELIVERY', amount: '100.00' } },
    },
    include: { payments: true },
  });
  await adjustStock({ productId, quantityChange: -quantity, type: 'SALE', orderId: order.id });
  return order;
};

after(async () => {
  const productWhere = { slug: { startsWith: tag } };
  await prisma.inventoryTransaction.deleteMany({ where: { product: productWhere } });
  await prisma.payment.deleteMany({ where: { order: { userId: customer.id } } });
  await prisma.order.deleteMany({ where: { userId: customer.id } });
  await prisma.product.deleteMany({ where: productWhere });
  await prisma.category.deleteMany({ where: { slug: { startsWith: tag }, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.brand.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.banner.deleteMany({ where: { title: { startsWith: tag } } });
  await prisma.auditLog.deleteMany({ where: { actorId: adminUser.id } });
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

const ADMIN_PATHS = ['stats', 'notifications', 'users', 'products', 'categories', 'brands', 'inventory', 'orders', 'payments', 'banners', 'settings', 'logs/activity', 'logs/logins'];

test('anonymous users and customers are refused on every admin API', async () => {
  for (const path of ADMIN_PATHS) {
    assert.equal((await request(app).get(`/api/admin/${path}`)).status, 401, path);
    assert.equal((await customerClient.get(`/api/admin/${path}`)).status, 401, path);
    assert.equal((await admin.get(`/api/admin/${path}`)).status, 200, path);
  }
  assert.equal((await customerClient.post('/api/admin/products', {})).status, 401);
  assert.equal((await customerClient.delete(`/api/admin/products/${randomUUID()}`)).status, 401);
});

test('statistics match the database and react to changes', async () => {
  const totals = async () => (await admin.get('/api/admin/stats')).body.data.totals;
  const before = await totals();
  assert.equal(before.totalProducts, await prisma.product.count({ where: { status: { not: 'ARCHIVED' } } }));
  assert.equal(before.totalCustomers, await prisma.user.count({ where: { role: 'CUSTOMER', status: { not: 'DELETED' } } }));

  const low = (await newProduct('statlow', { initialStock: 2, lowStockAlert: 5 })).body.data;
  await newProduct('statout');
  const order = await makeOrder('stat', low.id, 1);
  const during = await totals();
  assert.equal(during.totalProducts, before.totalProducts + 2);
  assert.equal(during.lowStockProducts, before.lowStockProducts + 1);
  assert.equal(during.outOfStockProducts, before.outOfStockProducts + 1);
  assert.equal(during.totalOrders, before.totalOrders + 1);
  assert.equal(during.pendingOrders, before.pendingOrders + 1);
  assert.equal(Number(during.totalRevenue), Number(before.totalRevenue));

  await admin.patch(`/api/admin/payments/${order.payments[0].id}/status`, { status: 'PAID' });
  const paid = await admin.get('/api/admin/stats');
  assert.equal(Number(paid.body.data.totals.totalRevenue), Number(before.totalRevenue) + 100);
  assert.equal(paid.body.data.dailySales.length, 30);
  assert.ok(paid.body.data.dailySales.at(-1).revenue >= 100);
});

test('products: create, edit, filter, archive, and no direct stock edits', async () => {
  const created = await newProduct('crud', {
    initialStock: 10,
    status: 'PUBLISHED',
    specifications: [{ name: 'Color', value: 'Blue' }],
  });
  assert.equal(created.status, 201);
  const product = created.body.data;
  assert.equal(product.stockQuantity, 10);

  const edit = await admin.patch(`/api/admin/products/${product.id}`, { price: '80.00' });
  assert.equal(edit.body.data.price, '80');
  assert.equal(edit.body.data.publishedAt, product.publishedAt);

  const resaved = await admin.patch(`/api/admin/products/${product.id}`, { status: 'PUBLISHED' });
  assert.equal(resaved.body.data.publishedAt, product.publishedAt);

  assert.equal((await admin.patch(`/api/admin/products/${product.id}`, { stockQuantity: 999 })).status, 400);
  assert.equal((await admin.patch(`/api/admin/products/${product.id}`, { discountPrice: '90.00' })).status, 400, 'database rule');

  const found = await admin.get('/api/admin/products').query({ search: `${tag} crud` });
  assert.equal(found.body.meta.total, 1);

  assert.equal((await admin.delete(`/api/admin/products/${product.id}`)).status, 200);
  const archived = await prisma.product.findUnique({ where: { id: product.id } });
  assert.equal(archived.status, 'ARCHIVED');
  assert.equal((await request(app).get(`/api/products/${product.slug}`)).status, 404);
});

test('validation rejects bad input, including script URLs', async () => {
  assert.equal((await newProduct('bad', { price: '-5' })).status, 400);
  assert.equal((await newProduct('badd', { discountPrice: '200.00' })).status, 400);
  assert.equal((await newProduct('badi', { images: [{ url: 'https://example.com/a.png' }] })).status, 400);
  assert.equal((await admin.post('/api/admin/banners', { title: 'x', linkUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin.post('/api/admin/banners', { title: 'x', linkUrl: '//evil.example' })).status, 400);
  assert.equal((await admin.get('/api/admin/products/not-a-uuid')).status, 400);
  assert.equal((await admin.get(`/api/admin/products/${randomUUID()}`)).status, 404);
});

test('duplicates return 409, and categories cannot nest inside themselves', async () => {
  await newProduct('dup');
  assert.equal((await newProduct('dup')).status, 409);

  const child = (await admin.post('/api/admin/categories', { name: `${tag} Child`, parentId: category.id })).body.data;
  const cycle = await admin.patch(`/api/admin/categories/${category.id}`, { parentId: child.id });
  assert.equal(cycle.status, 400);
});

test('deleting a brand removes it when unused, and archives it when it has products', async () => {
  const unused = (await admin.post('/api/admin/brands', { name: `${tag} Unused` })).body.data;
  const gone = await admin.delete(`/api/admin/brands/${unused.id}`);
  assert.equal(gone.body.data.outcome, 'deleted');
  assert.equal(await prisma.brand.count({ where: { id: unused.id } }), 0);

  const used = (await admin.post('/api/admin/brands', { name: `${tag} Used` })).body.data;
  await newProduct('branded', { brandId: used.id });
  const kept = await admin.delete(`/api/admin/brands/${used.id}`);
  assert.equal(kept.body.data.outcome, 'archived');
  assert.equal((await prisma.brand.findUnique({ where: { id: used.id } })).isActive, false);
  assert.equal((await request(app).get(`/api/brands/${used.slug}`)).status, 404);

  const products = await admin.get('/api/admin/products').query({ brandId: used.id });
  assert.equal(products.body.meta.total, 1);
});

test('deleting a category removes it when unused, and archives it when it has products', async () => {
  const unused = (await admin.post('/api/admin/categories', { name: `${tag} Empty` })).body.data;
  assert.equal((await admin.delete(`/api/admin/categories/${unused.id}`)).body.data.outcome, 'deleted');
  assert.equal(await prisma.category.count({ where: { id: unused.id } }), 0);

  const used = (await admin.post('/api/admin/categories', { name: `${tag} Full` })).body.data;
  await newProduct('categorized', { categoryId: used.id });
  assert.equal((await admin.delete(`/api/admin/categories/${used.id}`)).body.data.outcome, 'archived');
  assert.equal((await prisma.category.findUnique({ where: { id: used.id } })).isActive, false);
});

test('deleting a product removes it only when it has no stock or order history', async () => {
  const clean = (await newProduct('clean')).body.data;
  const removed = await admin.delete(`/api/admin/products/${clean.id}`);
  assert.equal(removed.body.data.outcome, 'deleted');
  assert.equal(await prisma.product.count({ where: { id: clean.id } }), 0);

  const stocked = (await newProduct('stocked', { initialStock: 1 })).body.data;
  const archived = await admin.delete(`/api/admin/products/${stocked.id}`);
  assert.equal(archived.body.data.outcome, 'archived');
  assert.equal(await prisma.inventoryTransaction.count({ where: { productId: stocked.id } }), 1);
});

test('publication is separate from stock', async () => {
  const product = (await newProduct('pub', { status: 'PUBLISHED' })).body.data;
  const outOfStock = await request(app).get(`/api/products/${product.slug}`);
  assert.equal(outOfStock.status, 200);
  assert.equal(outOfStock.body.data.inStock, false);

  await admin.post('/api/admin/inventory/adjust', { productId: product.id, quantityChange: 3, type: 'RESTOCK', note: 'Test' });
  const unpublished = await admin.patch(`/api/admin/products/${product.id}`, { status: 'DRAFT' });
  assert.equal(unpublished.body.data.stockQuantity, 3);
  assert.equal((await request(app).get(`/api/products/${product.slug}`)).status, 404);
});

test('inventory adjustments update stock, keep history and refuse overselling', async () => {
  const product = (await newProduct('stock', { initialStock: 5 })).body.data;
  const adjust = (quantityChange, type = 'ADJUSTMENT') =>
    admin.post('/api/admin/inventory/adjust', { productId: product.id, quantityChange, type, note: 'Test' });

  assert.equal((await adjust(3, 'RESTOCK')).status, 201);
  assert.equal((await adjust(-1)).status, 201);
  assert.equal((await adjust(-100)).status, 409);
  assert.equal((await adjust(-1, 'RESTOCK')).status, 400);

  const history = await admin.get('/api/admin/inventory').query({ productId: product.id });
  assert.equal(history.body.meta.total, 3);
  assert.equal(history.body.data[0].stockAfter, 7);
  assert.equal(history.body.data[0].performedBy.email, adminUser.email);
});

test('orders follow allowed status changes, and cancelling restores stock once', async () => {
  const product = (await newProduct('ordered', { initialStock: 5 })).body.data;
  const order = await makeOrder('cancel', product.id, 2);
  const stock = async () => (await prisma.product.findUnique({ where: { id: product.id } })).stockQuantity;
  const setStatus = (status) => admin.patch(`/api/admin/orders/${order.id}/status`, { status });
  assert.equal(await stock(), 3);

  assert.equal((await setStatus('DELIVERED')).status, 409);
  const confirmed = await setStatus('CONFIRMED');
  assert.deepEqual(confirmed.body.data.allowedStatuses, ['PROCESSING', 'CANCELLED']);

  assert.equal((await setStatus('CANCELLED')).status, 200);
  assert.equal(await stock(), 5);
  assert.equal((await setStatus('CANCELLED')).status, 409);
  assert.equal(await stock(), 5);

  const detail = await admin.get(`/api/admin/orders/${order.id}`);
  assert.equal(detail.body.data.status, 'CANCELLED');
  assert.equal(detail.body.data.payments.length, 1);
});

test('payments follow allowed changes and update the order', async () => {
  const product = (await newProduct('paid', { initialStock: 1 })).body.data;
  const order = await makeOrder('pay', product.id, 1);
  const setStatus = (status) => admin.patch(`/api/admin/payments/${order.payments[0].id}/status`, { status });

  assert.equal((await setStatus('REFUNDED')).status, 409);
  const paid = await setStatus('PAID');
  assert.ok(paid.body.data.paidAt);
  assert.equal((await prisma.order.findUnique({ where: { id: order.id } })).paymentStatus, 'PAID');
});

test('suspending a customer ends their session, and admins cannot be suspended', async () => {
  const target = await makeUser('target', 'CUSTOMER');
  const targetClient = await clientFor('/api/auth/login', target.email);
  const res = await admin.patch(`/api/admin/users/${target.id}/status`, { status: 'SUSPENDED' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.passwordHash, undefined);
  assert.equal((await targetClient.get('/api/auth/me')).status, 401);

  assert.equal((await admin.patch(`/api/admin/users/${adminUser.id}/status`, { status: 'SUSPENDED' })).status, 403);
  assert.equal((await admin.patch(`/api/admin/users/${target.id}/status`, { role: 'ADMIN' })).status, 400);

  const list = await admin.get('/api/admin/users').query({ search: tag });
  assert.doesNotMatch(JSON.stringify(list.body), /passwordHash/);
});

test('banners and settings can be managed', async () => {
  const banner = await admin.post('/api/admin/banners', { title: `${tag} Sale`, linkUrl: '/shop', sortOrder: 2 });
  assert.equal(banner.status, 201);
  const edited = await admin.patch(`/api/admin/banners/${banner.body.data.id}`, { isActive: false });
  assert.equal(edited.body.data.isActive, false);
  const bad = await admin.patch(`/api/admin/banners/${banner.body.data.id}`, { startsAt: '2030-01-02', endsAt: '2030-01-01' });
  assert.equal(bad.status, 400);
  assert.equal((await admin.delete(`/api/admin/banners/${banner.body.data.id}`)).status, 200);

  const key = `test_${tag.replace(/[^a-z0-9]/g, '_')}`;
  assert.equal((await admin.put(`/api/admin/settings/${key}`, { value: { a: 1 }, isPublic: false })).status, 200);
  assert.equal((await admin.put(`/api/admin/settings/${key}`, { value: 2 })).body.data.value, 2);
  assert.equal((await admin.put('/api/admin/settings/Bad-Key', { value: 2 })).status, 400);
  assert.equal((await admin.delete(`/api/admin/settings/${key}`)).status, 200);
});

test('admin changes appear in the activity log, and logins in the login log', async () => {
  const product = (await newProduct('logged')).body.data;
  const activity = await admin.get('/api/admin/logs/activity').query({ search: 'product.created', limit: 100 });
  const entry = activity.body.data.find(({ entityId }) => entityId === product.id);
  assert.equal(entry.actor.email, adminUser.email);

  const logins = await admin.get('/api/admin/logs/logins').query({ search: adminUser.email });
  assert.ok(logins.body.meta.total >= 1);
  assert.equal(logins.body.data[0].success, true);
});

test('notifications report the shape the header expects', async () => {
  const res = await admin.get('/api/admin/notifications');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.data.pendingOrders, 'number');
  assert.ok(Array.isArray(res.body.data.lowStock));
  assert.ok(Array.isArray(res.body.data.outOfStock));
});
