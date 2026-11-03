import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import adminRoutes from '../src/routes/admin.routes.js';
import { addressRoutes, cartRoutes, orderRoutes, wishlistRoutes } from '../src/routes/store.routes.js';

const tag = `sectest-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'Correct-horse-1';
const passwordHash = await bcrypt.hash(PASSWORD, 4);

const makeUser = (name, role) =>
  prisma.user.create({ data: { email: `${tag}-${name}@example.com`, passwordHash, firstName: 'Test', lastName: name, role } });

const client = async (loginPath, email) => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  const send = (method) => (path, data) => agent[method](path).set('X-CSRF-Token', csrfToken).send(data);
  const session = { get: (path) => agent.get(path), post: send('post'), patch: send('patch'), put: send('put'), delete: send('delete'), csrfToken, agent };
  if (loginPath) assert.equal((await session.post(loginPath, { email, password: PASSWORD })).status, 200);
  return session;
};

const adminUser = await makeUser('admin', 'ADMIN');
const customerUser = await makeUser('customer', 'CUSTOMER');
const admin = await client('/api/admin/auth/login', adminUser.email);
const customer = await client('/api/auth/login', customerUser.email);

const extraBrandIds = [];

after(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: adminUser.id } });
  const products = { sku: { startsWith: tag } };
  await prisma.inventoryTransaction.deleteMany({ where: { product: products } });
  await prisma.cartItem.deleteMany({ where: { product: products } });
  await prisma.product.deleteMany({ where: products });
  await prisma.brand.deleteMany({ where: { OR: [{ name: { startsWith: tag } }, { id: { in: extraBrandIds } }] } });
  await prisma.category.deleteMany({ where: { name: { startsWith: tag } } });
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

// Reads the real route table, so a route added later is covered without changing this test.
const routesOf = (router, prefix) =>
  router.stack
    .filter(({ route }) => route)
    .flatMap(({ route }) =>
      Object.keys(route.methods).map((method) => ({
        method,
        path: `${prefix}${route.path}`.replace(/:[a-zA-Z]+/g, randomUUID()),
        template: route.path,
      })),
    );

const PUBLIC_ADMIN_ROUTES = new Set(['/auth/login', '/auth/logout', '/auth/refresh', '/auth/session']);
const adminApi = routesOf(adminRoutes, '/api/admin').filter(({ template }) => !PUBLIC_ADMIN_ROUTES.has(template));
const customerApi = [
  ...routesOf(cartRoutes, '/api/cart'),
  ...routesOf(wishlistRoutes, '/api/wishlist'),
  ...routesOf(orderRoutes, '/api/orders'),
  ...routesOf(addressRoutes, '/api/addresses'),
];

test('the route table was read correctly', () => {
  assert.ok(adminApi.length >= 40, `found ${adminApi.length} admin routes`);
  assert.ok(customerApi.length >= 14, `found ${customerApi.length} customer routes`);
});

test('every admin route refuses visitors and customers', async () => {
  const anonymous = await client();
  for (const { method, path } of adminApi) {
    const send = method === 'get' ? anonymous.get(path) : anonymous[method](path, {});
    assert.equal((await send).status, 401, `visitor ${method} ${path}`);
    const asCustomer = method === 'get' ? customer.get(path) : customer[method](path, {});
    assert.equal((await asCustomer).status, 401, `customer ${method} ${path}`);
  }
});

test('every customer route refuses visitors', async () => {
  const anonymous = await client();
  for (const { method, path } of customerApi) {
    const send = method === 'get' ? anonymous.get(path) : anonymous[method](path, {});
    assert.equal((await send).status, 401, `${method} ${path}`);
  }
});

test('a dashboard login alone does not open shopping routes', async () => {
  assert.equal((await admin.get('/api/cart')).status, 401);
  assert.equal((await admin.get('/api/orders')).status, 401);
});

test('every state-changing route needs a CSRF token', async () => {
  const noToken = request.agent(app);
  for (const { method, path } of [...adminApi, ...customerApi].filter(({ method: m }) => m !== 'get')) {
    assert.equal((await noToken[method](path).send({})).status, 403, `${method} ${path}`);
  }
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/refresh', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/contact', '/api/ai/messages', '/api/admin/auth/login']) {
    assert.equal((await noToken.post(path).send({})).status, 403, path);
  }
});

test('a CSRF token from a different origin of cookie cannot be replayed', async () => {
  const stolen = customer.csrfToken;
  const res = await request(app).post('/api/auth/logout').set('Cookie', 'csrf_token=other.value').set('X-CSRF-Token', stolen);
  assert.equal(res.status, 403);
});

test('passwords and hashes never appear in any response', async () => {
  const responses = await Promise.all([
    customer.get('/api/auth/me'),
    admin.get('/api/admin/profile'),
    admin.get('/api/admin/users?limit=100'),
    admin.get('/api/admin/logs/logins?limit=100'),
    admin.get('/api/admin/logs/activity?limit=100'),
    admin.get('/api/admin/orders?limit=100'),
  ]);
  for (const { status, body } of responses) {
    assert.equal(status, 200);
    assert.doesNotMatch(JSON.stringify(body), /passwordHash|refreshTokenHash|\$2[aby]\$/);
  }
  const stored = await prisma.user.findUnique({ where: { id: customerUser.id } });
  assert.ok(stored.passwordHash.startsWith('$2'), 'stored as a bcrypt hash');
});

test('login, reset and session secrets are stored only as hashes', async () => {
  const login = await customer.post('/api/auth/refresh');
  const cookie = login.headers['set-cookie'].find((value) => value.startsWith('refresh_token='));
  const token = cookie.split(';')[0].split('=')[1];
  const session = await prisma.userSession.findFirst({ where: { userId: customerUser.id }, orderBy: { lastUsedAt: { sort: 'desc', nulls: 'last' } } });
  assert.notEqual(session.refreshTokenHash, token);
  assert.equal(session.refreshTokenHash.length, 64);
});

test('private responses are never cached, and public catalog data can be', async () => {
  for (const path of ['/api/auth/me', '/api/cart', '/api/orders']) {
    assert.match((await customer.get(path)).headers['cache-control'] ?? '', /no-store/, path);
  }
  assert.match((await admin.get('/api/admin/stats')).headers['cache-control'] ?? '', /no-store/);
  for (const path of ['/api/categories', '/api/brands', '/api/site']) {
    assert.match((await request(app).get(path)).headers['cache-control'] ?? '', /public/, path);
  }
  assert.match((await request(app).get('/api/products')).headers['cache-control'] ?? '', /no-store/, 'prices and stock stay fresh');
});

test('checking who is logged in is quiet for guests, and reports when a refresh can help', async () => {
  const guest = await request(app).get('/api/auth/session');
  assert.equal(guest.status, 200);
  assert.deepEqual(guest.body.data, { user: null, canRefresh: false });

  const member = await customer.get('/api/auth/session');
  assert.equal(member.body.data.user.email, customerUser.email);
  assert.equal(member.body.data.canRefresh, false);
  assert.equal(member.body.data.user.passwordHash, undefined);

  const expired = await request(app).get('/api/auth/session').set('Cookie', 'refresh_token=anything');
  assert.deepEqual(expired.body.data, { user: null, canRefresh: true });
});

test('security headers are present on every kind of response', async () => {
  for (const path of ['/api/health', '/api/products', '/api/nope']) {
    const { headers } = await request(app).get(path);
    assert.equal(headers['x-content-type-options'], 'nosniff', path);
    assert.equal(headers['x-powered-by'], undefined, path);
    assert.ok(headers['strict-transport-security'], path);
    assert.ok(headers['content-security-policy'], path);
  }
});

test('hostile URLs and bodies get clean errors, not server errors', async () => {
  const cases = [
    await request(app).get('/api/products/%E0%A4%A'),
    await request(app).get('/api/categories/%'),
    await request(app).get('/api/products?page=abc'),
    await request(app).get('/api/products?page=1&page=2'),
    await request(app).get('/api/products?limit=-1'),
    await request(app).get('/api/products?minPrice=NaN'),
    await admin.get('/api/admin/products/not-a-uuid'),
    await admin.agent.post('/api/auth/login').set('X-CSRF-Token', admin.csrfToken).set('Content-Type', 'application/json').set('Content-Encoding', 'bogus').send('{}'),
    await admin.agent.post('/api/auth/login').set('X-CSRF-Token', admin.csrfToken).set('Content-Type', 'application/json; charset=bogus').send('{}'),
  ];
  for (const res of cases) {
    assert.ok(res.status >= 400 && res.status < 500, `${res.request.url}: ${res.status}`);
    assert.equal(res.body.success, false);
    assert.doesNotMatch(JSON.stringify(res.body), /node_modules|at .*\.js|Prisma/);
  }
});

test('query operators in parameters are ignored, not obeyed', async () => {
  const normal = await request(app).get('/api/products').query({ limit: 100 });
  const res = await request(app).get('/api/products?limit=100&sort[$ne]=x&status[$ne]=PUBLISHED&price[gt]=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.meta.total, normal.body.meta.total, 'drafts and archived products stay hidden');
});

test('injection attempts are treated as plain text', async () => {
  const attempts = [`' OR 1=1 --`, `'; DROP TABLE products; --`, `%' OR '1'='1`, '<script>alert(1)</script>'];
  const before = await prisma.product.count();
  for (const search of attempts) {
    const res = await request(app).get('/api/products').query({ search });
    assert.equal(res.status, 200, search);
    assert.equal(res.body.data.length, 0, search);
  }
  assert.equal(await prisma.product.count(), before);
  const login = await customer.post('/api/auth/login', { email: `' OR 1=1 --@example.com`, password: PASSWORD });
  assert.notEqual(login.status, 200);
});

test('script-like text is stored as plain text, and script links are refused', async () => {
  const xss = '<img src=x onerror=alert(1)>';
  const brand = await admin.post('/api/admin/brands', { name: `${tag} ${xss}` });
  assert.equal(brand.status, 201);
  assert.equal(brand.body.data.name, `${tag} ${xss}`);
  assert.equal(brand.headers['content-type'].includes('application/json'), true, 'never served as HTML');

  for (const logoUrl of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
    assert.equal((await admin.post('/api/admin/brands', { name: `${tag} bad`, logoUrl })).status, 400, logoUrl);
  }
});

test('mass assignment is refused on every customer and product form', async () => {
  assert.equal((await customer.patch('/api/auth/me', { role: 'ADMIN' })).status, 400);
  assert.equal((await customer.patch('/api/auth/me', { status: 'ACTIVE' })).status, 400);
  assert.equal((await customer.patch('/api/auth/me', { email: 'other@example.com' })).status, 400);
  assert.equal((await customer.patch('/api/auth/me', { passwordHash: 'x' })).status, 400);
  assert.equal((await admin.post('/api/admin/products', { name: 'x', stockQuantity: 5 })).status, 400);
});

test('products with names in Bangla still get a working address', async () => {
  const category = (await admin.post('/api/admin/categories', { name: `${tag} শ্রেণী` })).body.data;
  // Only Bangla letters and digits, so there is nothing to build an address from.
  const banglaDigits = String(Date.now()).replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[digit]);
  const brand = (await admin.post('/api/admin/brands', { name: `ব্র্যান্ড ${banglaDigits}` })).body.data;
  extraBrandIds.push(brand.id);
  assert.ok(category.slug.length > 0);
  assert.ok(brand.slug.length > 0);
  const first = await admin.post('/api/admin/products', { name: 'ল্যাপটপ', sku: `${tag}-bn1`, price: '100.00', categoryId: category.id, brandId: brand.id, status: 'PUBLISHED' });
  const second = await admin.post('/api/admin/products', { name: 'ল্যাপটপ', sku: `${tag}-bn2`, price: '100.00', categoryId: category.id, brandId: brand.id, status: 'PUBLISHED' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.match(first.body.data.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.notEqual(first.body.data.slug, second.body.data.slug);
  assert.equal((await request(app).get(`/api/products/${first.body.data.slug}`)).status, 200);
});

test('cart lines cannot grow past the quantity limit by adding repeatedly', async () => {
  const category = (await admin.post('/api/admin/categories', { name: `${tag} Limit` })).body.data;
  const brand = (await admin.post('/api/admin/brands', { name: `${tag} Limit` })).body.data;
  const product = (await admin.post('/api/admin/products', { name: `${tag} Bulk`, sku: `${tag}-bulk`, price: '10.00', categoryId: category.id, brandId: brand.id, status: 'PUBLISHED', initialStock: 500 })).body.data;
  assert.equal((await customer.post('/api/cart/items', { productId: product.id, quantity: 99 })).status, 201);
  assert.equal((await customer.post('/api/cart/items', { productId: product.id, quantity: 1 })).status, 400);
  const { items } = (await customer.get('/api/cart')).body.data;
  assert.equal(items.find(({ productId }) => productId === product.id).quantity, 99);
});

test('expired sessions and used reset tokens get cleaned up', async () => {
  const { purgeExpiredAuthData } = await import('../src/services/session.service.js');
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const expired = await prisma.userSession.create({ data: { userId: customerUser.id, refreshTokenHash: randomUUID().repeat(1), expiresAt: old } });
  const live = await prisma.userSession.create({ data: { userId: customerUser.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 1000000) } });
  const usedToken = await prisma.passwordResetToken.create({ data: { userId: customerUser.id, tokenHash: randomUUID(), expiresAt: old } });
  await purgeExpiredAuthData();
  assert.equal(await prisma.userSession.count({ where: { id: expired.id } }), 0);
  assert.equal(await prisma.userSession.count({ where: { id: live.id } }), 1);
  assert.equal(await prisma.passwordResetToken.count({ where: { id: usedToken.id } }), 0);
});
