import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/prisma.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { createRateLimiter } from '../src/middleware/rateLimit.middleware.js';

// Uses its own tagged rows, removed afterwards, so results don't depend on seed data.
const tag = `apitest-${randomUUID().slice(0, 8)}`;

const category = await prisma.category.create({ data: { name: tag, slug: tag } });
const brand = await prisma.brand.create({ data: { name: tag, slug: tag } });

const makeProduct = (suffix, fields) =>
  prisma.product.create({
    data: {
      name: `${tag} ${suffix}`,
      slug: `${tag}-${suffix}`,
      sku: `${tag}-${suffix}`,
      categoryId: category.id,
      brandId: brand.id,
      status: 'PUBLISHED',
      ...fields,
    },
  });

await makeProduct('cheap', { price: '10.00', stockQuantity: 1 });
await makeProduct('discounted', { price: '100.00', discountPrice: '5.00', stockQuantity: 0 });
await makeProduct('pricey', { price: '50.00', stockQuantity: 1 });
await makeProduct('draft', { price: '1.00', status: 'DRAFT' });

after(async () => {
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: tag } });
  await prisma.brand.deleteMany({ where: { slug: tag } });
  await prisma.$disconnect();
});

test('product list hides drafts and includes pagination meta', async () => {
  const res = await request(app).get('/api/products').query({ brand: tag });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.length, 3);
  assert.deepEqual(res.body.meta, {
    page: 1,
    limit: 20,
    total: 3,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  });
});

test('pagination returns the requested page', async () => {
  const res = await request(app).get('/api/products').query({ brand: tag, limit: 2, page: 2, sort: 'name' });
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.meta.totalPages, 2);
  assert.equal(res.body.meta.hasNextPage, false);
  assert.equal(res.body.meta.hasPreviousPage, true);
});

test('price sorting and filtering use the discounted price', async () => {
  const sorted = await request(app).get('/api/products').query({ brand: tag, sort: 'price_asc' });
  assert.deepEqual(
    sorted.body.data.map(({ effectivePrice }) => effectivePrice),
    ['5.00', '10.00', '50.00'],
  );

  const filtered = await request(app).get('/api/products').query({ brand: tag, maxPrice: 6 });
  assert.equal(filtered.body.data.length, 1);
  assert.equal(filtered.body.data[0].discountPercent, 95);
  assert.equal(filtered.body.data[0].inStock, false);
});

test('search is case-insensitive', async () => {
  const res = await request(app).get('/api/products').query({ search: `${tag} PRICEY`.toUpperCase() });
  assert.equal(res.body.data.length, 1);
});

test('product detail works by slug, and drafts return 404', async () => {
  const found = await request(app).get(`/api/products/${tag}-cheap`);
  assert.equal(found.status, 200);
  assert.equal(found.body.data.price, '10.00');
  assert.equal(found.body.data.stockQuantity, undefined);

  const draft = await request(app).get(`/api/products/${tag}-draft`);
  assert.equal(draft.status, 404);
  assert.equal(draft.body.success, false);
});

test('categories and brands are listed and found by slug', async () => {
  for (const path of ['categories', 'brands']) {
    const list = await request(app).get(`/api/${path}`).query({ limit: 100 });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some(({ slug }) => slug === tag));

    const one = await request(app).get(`/api/${path}/${tag}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.slug, tag);

    const missing = await request(app).get(`/api/${path}/${tag}-missing`);
    assert.equal(missing.status, 404);
  }
});

test('invalid queries return 400 with field errors', async () => {
  const cases = [
    [{ page: 0 }, 'page'],
    [{ limit: 101 }, 'limit'],
    [{ sort: 'bogus' }, 'sort'],
    [{ featured: 'maybe' }, 'featured'],
    [{ minPrice: 10, maxPrice: 5 }, 'minPrice'],
  ];
  for (const [query, field] of cases) {
    const res = await request(app).get('/api/products').query(query);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Validation failed');
    assert.equal(res.body.errors[0].field, field);
  }
});

test('invalid slugs return 400', async () => {
  const res = await request(app).get('/api/products/Not_A_Slug');
  assert.equal(res.status, 400);
  assert.equal(res.body.errors[0].location, 'params');
});

test('every route group is mounted', async () => {
  for (const group of ['users', 'inventory']) {
    const res = await request(app).get(`/api/${group}`);
    assert.equal(res.status, 501, group);
    assert.equal(res.body.success, false);
  }
});

test('malformed JSON returns 400', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"broken":');
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Request body contains invalid JSON');
});

test('database errors map to safe responses', async () => {
  const known = (code) => new Prisma.PrismaClientKnownRequestError('secret connection detail', { code, clientVersion: 'x' });
  const cases = [
    [known('P2002'), 409],
    [known('P2025'), 404],
    [known('P1001'), 503],
    [new Prisma.PrismaClientUnknownRequestError('code: "23001" secret detail', { clientVersion: 'x' }), 409],
    [new Error('secret internal detail'), 500],
  ];
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const [error, status] of cases) {
      const testApp = express();
      testApp.get('/', () => {
        throw error;
      });
      testApp.use(errorHandler);
      const res = await request(testApp).get('/');
      assert.equal(res.status, status);
      assert.equal(res.body.success, false);
      assert.doesNotMatch(JSON.stringify(res.body), /secret/);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('rate limiter returns 429 in the standard error format', async () => {
  const testApp = express();
  testApp.use(createRateLimiter({ max: 1 }));
  testApp.get('/', (req, res) => res.json({ success: true }));
  assert.equal((await request(testApp).get('/')).status, 200);
  const limited = await request(testApp).get('/');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.success, false);
});

test('security headers and CORS are configured', async () => {
  const res = await request(app).get('/api/health').set('Origin', env.clientUrl);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['access-control-allow-origin'], env.clientUrl);
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  assert.equal(res.headers['x-powered-by'], undefined);

  const other = await request(app).get('/api/health').set('Origin', 'https://evil.example');
  assert.notEqual(other.headers['access-control-allow-origin'], 'https://evil.example');
});
