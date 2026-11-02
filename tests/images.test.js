import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { MAX_IMAGE_BYTES } from '../src/middleware/upload.middleware.js';
import { imageStorage } from '../src/services/cloudinary.service.js';

// Cloudinary is replaced with this fake, so nothing is uploaded for real.
const realStorage = { ...imageStorage };
let uploadedCount = 0;
let destroyed = [];
let failUploadNumber = null;

const fakeStorage = () => {
  imageStorage.upload = async () => {
    uploadedCount += 1;
    if (uploadedCount === failUploadNumber) throw new Error('upload failed');
    return { url: `https://res.example.com/${uploadedCount}.png`, publicId: `fake/${randomUUID()}` };
  };
  imageStorage.destroy = async (publicId) => {
    destroyed.push(publicId);
  };
};

beforeEach(() => {
  uploadedCount = 0;
  destroyed = [];
  failUploadNumber = null;
  fakeStorage();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);

const tag = `imgtest-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'Correct-horse-1';
const adminUser = await prisma.user.create({
  data: {
    email: `${tag}@example.com`,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    firstName: 'Test',
    lastName: 'Admin',
    role: 'ADMIN',
  },
});

const agent = request.agent(app);
const csrfToken = (await agent.get('/api/auth/csrf-token')).body.data.csrfToken;
const csrf = (req) => req.set('X-CSRF-Token', csrfToken);
await csrf(agent.post('/api/admin/auth/login')).send({ email: adminUser.email, password: PASSWORD });

const category = await prisma.category.create({ data: { name: tag, slug: tag } });
const brand = await prisma.brand.create({ data: { name: tag, slug: tag } });
let counter = 0;
const makeProduct = () => {
  counter += 1;
  const name = `${tag}-${counter}`;
  return prisma.product.create({ data: { name, slug: name, sku: name, price: '10.00', categoryId: category.id, brandId: brand.id } });
};
const upload = (product, ...buffers) => {
  const req = csrf(agent.post(`/api/admin/products/${product.id}/images`));
  buffers.forEach((buffer, index) => req.attach('images', buffer, `photo${index}.png`));
  return req;
};
const imagesOf = (product) =>
  prisma.productImage.findMany({ where: { productId: product.id }, orderBy: { sortOrder: 'asc' } });

after(async () => {
  Object.assign(imageStorage, realStorage);
  await prisma.auditLog.deleteMany({ where: { actorId: adminUser.id } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: tag } });
  await prisma.brand.deleteMany({ where: { slug: tag } });
  await prisma.loginLog.deleteMany({ where: { email: adminUser.email } });
  await prisma.user.delete({ where: { id: adminUser.id } });
  await prisma.$disconnect();
});

test('uploads need an admin session', async () => {
  const product = await makeProduct();
  const anonymous = await request(app)
    .post(`/api/admin/products/${product.id}/images`)
    .set('Cookie', `csrf_token=${csrfToken}`)
    .set('X-CSRF-Token', csrfToken)
    .attach('images', PNG, 'a.png');
  assert.equal(anonymous.status, 401);
  assert.equal(uploadedCount, 0);
});

test('several images upload together, and the first becomes the main image', async () => {
  const product = await makeProduct();
  const res = await upload(product, PNG, JPEG, WEBP);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.images.length, 3);

  const stored = await imagesOf(product);
  assert.deepEqual(stored.map(({ isPrimary }) => isPrimary), [true, false, false]);
  assert.ok(stored.every(({ publicId }) => publicId.startsWith('fake/')));
});

test('files are checked by content, so a renamed file is refused', async () => {
  const product = await makeProduct();
  for (const fake of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('MZ not an image'), Buffer.from('')]) {
    const res = await csrf(agent.post(`/api/admin/products/${product.id}/images`))
      .attach('images', fake, { filename: 'photo.png', contentType: 'image/png' });
    assert.equal(res.status, 400);
  }
  assert.equal(uploadedCount, 0);
  assert.equal((await imagesOf(product)).length, 0);
});

test('size, count and missing-file limits are enforced', async () => {
  const product = await makeProduct();
  const large = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.equal((await upload(product, large)).status, 413);
  assert.equal((await upload(product, ...Array(11).fill(PNG))).status, 400);
  assert.equal((await csrf(agent.post(`/api/admin/products/${product.id}/images`))).status, 400);
  assert.equal(uploadedCount, 0);

  await upload(product, ...Array(10).fill(PNG));
  await upload(product, ...Array(10).fill(PNG));
  assert.equal((await upload(product, PNG)).status, 400, 'at most 20 per product');
});

test('a failed upload stores nothing and removes the files that worked', async () => {
  const product = await makeProduct();
  failUploadNumber = 2;
  const res = await upload(product, PNG, PNG, PNG);
  assert.equal(res.status, 500);
  assert.equal((await imagesOf(product)).length, 0);
  assert.equal(destroyed.length, 2);
});

test('replacing an image swaps the file and removes the old one', async () => {
  const product = await makeProduct();
  await upload(product, PNG);
  const [before] = await imagesOf(product);
  const res = await csrf(agent.put(`/api/admin/products/${product.id}/images/${before.id}`)).attach('image', JPEG, 'new.jpg');
  assert.equal(res.status, 200);
  const [afterwards] = await imagesOf(product);
  assert.notEqual(afterwards.publicId, before.publicId);
  assert.equal(afterwards.isPrimary, true);
  assert.deepEqual(destroyed, [before.publicId]);
});

test('deleting the main image promotes the next, and choosing a main image works', async () => {
  const product = await makeProduct();
  await upload(product, PNG, PNG, PNG);
  const [first, second, third] = await imagesOf(product);

  const chosen = await csrf(agent.patch(`/api/admin/products/${product.id}/images/${third.id}/primary`));
  assert.equal(chosen.status, 200);
  assert.deepEqual((await imagesOf(product)).map(({ isPrimary }) => isPrimary), [false, false, true]);

  assert.equal((await csrf(agent.delete(`/api/admin/products/${product.id}/images/${third.id}`))).status, 200);
  assert.deepEqual(destroyed, [third.publicId]);
  const left = await imagesOf(product);
  assert.deepEqual(left.map(({ id }) => id), [first.id, second.id]);
  assert.equal(left[0].isPrimary, true);
});

test('an image can only be changed through its own product', async () => {
  const owner = await makeProduct();
  const other = await makeProduct();
  await upload(owner, PNG);
  const [image] = await imagesOf(owner);
  assert.equal((await csrf(agent.delete(`/api/admin/products/${other.id}/images/${image.id}`))).status, 404);
  assert.equal((await imagesOf(owner)).length, 1);
});

test('really deleting a product removes its stored images', async () => {
  const product = await makeProduct();
  await upload(product, PNG, PNG);
  const stored = await imagesOf(product);
  const res = await csrf(agent.delete(`/api/admin/products/${product.id}`));
  assert.equal(res.body.data.outcome, 'deleted');
  assert.deepEqual(destroyed.sort(), stored.map(({ publicId }) => publicId).sort());
});

test('category images can be set, replaced and removed', async () => {
  const own = await prisma.category.create({ data: { name: `${tag}-c`, slug: `${tag}-c` } });
  const path = `/api/admin/categories/${own.id}/image`;
  const first = await csrf(agent.put(path)).attach('image', PNG, 'a.png');
  assert.equal(first.status, 200);
  const stored = await prisma.category.findUnique({ where: { id: own.id } });
  assert.ok(stored.imageUrl);

  await csrf(agent.put(path)).attach('image', JPEG, 'b.jpg');
  assert.deepEqual(destroyed, [stored.imagePublicId]);

  assert.equal((await csrf(agent.delete(path))).status, 200);
  const cleared = await prisma.category.findUnique({ where: { id: own.id } });
  assert.equal(cleared.imageUrl, null);
  assert.equal(cleared.imagePublicId, null);
  await prisma.category.delete({ where: { id: own.id } });
});

test('without Cloudinary settings, uploads explain that they are not configured', async () => {
  Object.assign(imageStorage, realStorage);
  const product = await makeProduct();
  const res = await upload(product, PNG);
  if (process.env.CLOUDINARY_CLOUD_NAME) return;
  assert.equal(res.status, 503);
  assert.equal(res.body.message, 'Image uploads are not configured yet');
});
