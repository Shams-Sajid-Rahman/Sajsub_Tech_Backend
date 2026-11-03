import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

const tag = `hometest-${randomUUID().slice(0, 8)}`;

const category = await prisma.category.create({ data: { name: tag, slug: tag } });
const brand = await prisma.brand.create({ data: { name: tag, slug: tag } });
const user = await prisma.user.create({ data: { email: `${tag}@example.com`, passwordHash: 'not-used', firstName: 'Amina', lastName: 'Rahman' } });

let counter = 0;
const makeProduct = (fields) => {
  counter += 1;
  const name = `${tag}-${counter}`;
  return prisma.product.create({
    data: { name, slug: name, sku: name, price: '100.00', stockQuantity: 10, status: 'PUBLISHED', categoryId: category.id, brandId: brand.id, ...fields },
  });
};

const makeOrder = (product, quantity, status) =>
  prisma.order.create({
    data: {
      orderNumber: `${tag}-${randomUUID().slice(0, 8)}`,
      userId: user.id,
      status,
      subtotalAmount: '100.00',
      totalAmount: '100.00',
      shippingAddress: {},
      items: { create: { productId: product.id, productName: product.name, productSku: product.sku, unitPrice: '100.00', quantity, lineTotal: '100.00' } },
    },
  });

const csrfAgent = async () => {
  const agent = request.agent(app);
  const { csrfToken } = (await agent.get('/api/auth/csrf-token')).body.data;
  return { post: (path, data) => agent.post(path).set('X-CSRF-Token', csrfToken).send(data) };
};

const mine = (rows) => rows.filter(({ slug }) => slug.startsWith(tag));

after(async () => {
  const products = { slug: { startsWith: tag } };
  await prisma.review.deleteMany({ where: { product: products } });
  await prisma.orderItem.deleteMany({ where: { product: products } });
  await prisma.order.deleteMany({ where: { userId: user.id } });
  await prisma.product.deleteMany({ where: products });
  await prisma.user.deleteMany({ where: { id: user.id } });
  await prisma.category.deleteMany({ where: { id: category.id } });
  await prisma.brand.deleteMany({ where: { id: brand.id } });
  await prisma.newsletterSubscriber.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

test('best sellers: only real sales count, most sold first', async () => {
  const [top, second, unpaid, cancelled, refunded, unsold, draft] = await Promise.all([
    makeProduct(),
    makeProduct(),
    makeProduct(),
    makeProduct(),
    makeProduct(),
    makeProduct(),
    makeProduct({ status: 'DRAFT' }),
  ]);
  await makeOrder(top, 5, 'DELIVERED');
  await makeOrder(top, 2, 'CONFIRMED');
  await makeOrder(second, 3, 'SHIPPED');
  await makeOrder(unpaid, 50, 'PENDING');
  await makeOrder(cancelled, 50, 'CANCELLED');
  await makeOrder(refunded, 50, 'REFUNDED');
  await makeOrder(draft, 50, 'DELIVERED');

  const res = await request(app).get('/api/products/best-sellers?limit=24');
  assert.equal(res.status, 200);
  const slugs = mine(res.body.data).map(({ slug }) => slug);
  assert.deepEqual(slugs, [top.slug, second.slug]);
  assert.ok(!slugs.includes(unsold.slug));

  assert.equal((await request(app).get('/api/products/best-sellers?limit=25')).status, 400);
  // The new path must not be mistaken for a product address.
  assert.equal((await request(app).get(`/api/products/${top.slug}`)).status, 200);
});

test('slugs filter: returns only those products, and refuses bad input', async () => {
  const [one, two] = await Promise.all([makeProduct(), makeProduct(), makeProduct()]);
  const res = await request(app).get(`/api/products?slugs=${one.slug},${two.slug}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map(({ slug }) => slug).sort(), [one.slug, two.slug].sort());

  assert.equal((await request(app).get('/api/products?slugs=')).status, 400);
  assert.equal((await request(app).get(`/api/products?slugs=${encodeURIComponent("a'--,b c")}`)).status, 400);
  const tooMany = Array.from({ length: 13 }, (_, index) => `item-${index}`).join(',');
  assert.equal((await request(app).get(`/api/products?slugs=${tooMany}`)).status, 400);
});

test('latest reviews: good written reviews only, with no private details', async () => {
  const product = await makeProduct();
  const other = await prisma.user.create({ data: { email: `${tag}-b@example.com`, passwordHash: 'not-used', firstName: 'Rafi', lastName: 'Karim' } });
  const third = await prisma.user.create({ data: { email: `${tag}-c@example.com`, passwordHash: 'not-used', firstName: 'Nila', lastName: 'Das' } });
  const fourth = await prisma.user.create({ data: { email: `${tag}-d@example.com`, passwordHash: 'not-used', firstName: 'Tanvir', lastName: 'Ali' } });
  try {
    await prisma.review.createMany({
      data: [
        { productId: product.id, userId: user.id, rating: 5, comment: `${tag} excellent` },
        { productId: product.id, userId: other.id, rating: 2, comment: `${tag} poor` },
        { productId: product.id, userId: third.id, rating: 5, comment: null },
        { productId: product.id, userId: fourth.id, rating: 4, comment: '' },
      ],
    });
    const res = await request(app).get('/api/reviews?limit=12');
    assert.equal(res.status, 200);
    const reviews = res.body.data.filter(({ product: { slug } }) => slug === product.slug);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].comment, `${tag} excellent`);
    assert.equal(reviews[0].author, 'Amina R.');
    const text = JSON.stringify(reviews[0]);
    assert.ok(!text.includes('@example.com') && !text.includes('Rahman') && !text.includes(user.id));
    assert.equal((await request(app).get('/api/reviews?limit=13')).status, 400);
  } finally {
    await prisma.review.deleteMany({ where: { productId: product.id } });
    await prisma.user.deleteMany({ where: { id: { in: [other.id, third.id, fourth.id] } } });
  }
});

test('newsletter: subscribing twice looks the same and stores one row', async () => {
  const email = `${tag}-news@example.com`;
  const agent = await csrfAgent();
  const first = await agent.post('/api/newsletter', { email: email.toUpperCase() });
  const second = await agent.post('/api/newsletter', { email });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(await prisma.newsletterSubscriber.count({ where: { email } }), 1);
});

test('newsletter: needs a CSRF token and a valid email, and refuses extra fields', async () => {
  const email = `${tag}-guard@example.com`;
  assert.equal((await request(app).post('/api/newsletter').send({ email })).status, 403);
  const agent = await csrfAgent();
  assert.equal((await agent.post('/api/newsletter', { email: 'not-an-email' })).status, 400);
  assert.equal((await agent.post('/api/newsletter', { email, isAdmin: true })).status, 400);
  assert.equal(await prisma.newsletterSubscriber.count({ where: { email } }), 0);
});
