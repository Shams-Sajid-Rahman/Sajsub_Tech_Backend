import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { adjustStock } from '../src/services/inventory.service.js';

// Runs against the configured database. Every row uses a unique tag and is removed afterwards.
const tag = `test-${randomUUID().slice(0, 8)}`;
let category;
let brand;
let product;
let user;
let order;

const makeProduct = (suffix, overrides = {}) =>
  prisma.product.create({
    data: {
      name: `${tag} ${suffix}`,
      slug: `${tag}-${suffix}`,
      sku: `${tag}-${suffix}`,
      price: '100.00',
      categoryId: category.id,
      brandId: brand.id,
      ...overrides,
    },
  });

category = await prisma.category.create({ data: { name: tag, slug: tag } });
brand = await prisma.brand.create({ data: { name: tag, slug: tag } });
product = await makeProduct('main', { stockQuantity: 5 });
user = await prisma.user.create({
  data: { email: `${tag}@example.com`, passwordHash: 'not-a-real-hash', firstName: 'Test', lastName: 'User' },
});

after(async () => {
  const productFilter = { product: { slug: { startsWith: tag } } };
  await prisma.inventoryTransaction.deleteMany({ where: productFilter });
  if (order) {
    await prisma.payment.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: tag } } });
  await prisma.category.deleteMany({ where: { slug: tag } });
  await prisma.brand.deleteMany({ where: { slug: tag } });
  await prisma.$disconnect();
});

test('new users default to the CUSTOMER role', () => {
  assert.equal(user.role, 'CUSTOMER');
});

test('database rejects negative stock', async () => {
  await assert.rejects(
    prisma.product.update({ where: { id: product.id }, data: { stockQuantity: -1 } }),
    /products_stock_non_negative/,
  );
});

test('database rejects a discount at or above the price', async () => {
  await assert.rejects(makeProduct('bad-discount', { discountPrice: '100.00' }), /products_discount_valid/);
});

test('database rejects uppercase emails', async () => {
  await assert.rejects(
    prisma.user.create({
      data: { email: `${tag}-UPPER@example.com`, passwordHash: 'x', firstName: 'A', lastName: 'B' },
    }),
    /users_email_lowercase/,
  );
});

test('duplicate SKUs are rejected', async () => {
  await assert.rejects(makeProduct('dup', { sku: product.sku }), { code: 'P2002' });
});

test('duplicate cart and wishlist items are rejected', async () => {
  const cart = await prisma.cart.create({
    data: { userId: user.id, items: { create: { productId: product.id } } },
  });
  await assert.rejects(prisma.cartItem.create({ data: { cartId: cart.id, productId: product.id } }), {
    code: 'P2002',
  });

  const wishlist = await prisma.wishlist.create({
    data: { userId: user.id, items: { create: { productId: product.id } } },
  });
  await assert.rejects(prisma.wishlistItem.create({ data: { wishlistId: wishlist.id, productId: product.id } }), {
    code: 'P2002',
  });
});

test('adjustStock updates stock and records the ledger entry', async () => {
  const target = await makeProduct('ledger', { stockQuantity: 10 });
  const entry = await adjustStock({ productId: target.id, quantityChange: -3, type: 'SALE' });
  assert.equal(entry.stockBefore, 10);
  assert.equal(entry.stockAfter, 7);
  const { stockQuantity } = await prisma.product.findUnique({ where: { id: target.id } });
  assert.equal(stockQuantity, 7);
});

test('adjustStock refuses to oversell and changes nothing', async () => {
  const target = await makeProduct('oversell', { stockQuantity: 2 });
  await assert.rejects(adjustStock({ productId: target.id, quantityChange: -3, type: 'SALE' }), {
    status: 409,
  });
  const fresh = await prisma.product.findUnique({
    where: { id: target.id },
    include: { inventoryTransactions: true },
  });
  assert.equal(fresh.stockQuantity, 2);
  assert.equal(fresh.inventoryTransactions.length, 0);
});

test('concurrent sales cannot oversell', async () => {
  const target = await makeProduct('concurrent', { stockQuantity: 3 });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => adjustStock({ productId: target.id, quantityChange: -1, type: 'SALE' })),
  );
  const sold = results.filter(({ status }) => status === 'fulfilled').length;
  const { stockQuantity } = await prisma.product.findUnique({ where: { id: target.id } });
  assert.equal(sold, 3);
  assert.equal(stockQuantity, 0);
});

test('a failed step rolls back the whole transaction', async () => {
  const target = await makeProduct('rollback', { stockQuantity: 4 });
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await adjustStock({ productId: target.id, quantityChange: -1, type: 'SALE' }, tx);
      throw new Error('checkout failed');
    }),
    /checkout failed/,
  );
  const { stockQuantity } = await prisma.product.findUnique({ where: { id: target.id } });
  assert.equal(stockQuantity, 4);
});

test('order items keep their snapshot, and sold products cannot be deleted', async () => {
  const sold = await makeProduct('sold', { stockQuantity: 1 });
  order = await prisma.order.create({
    data: {
      orderNumber: tag,
      userId: user.id,
      subtotalAmount: '100.00',
      totalAmount: '100.00',
      shippingAddress: { city: 'Test' },
      items: {
        create: {
          productId: sold.id,
          productName: sold.name,
          productSku: sold.sku,
          unitPrice: '100.00',
          quantity: 1,
          lineTotal: '100.00',
        },
      },
      payments: { create: { method: 'CASH_ON_DELIVERY', amount: '100.00' } },
    },
    include: { items: true, payments: true, user: true },
  });
  assert.equal(order.user.id, user.id);
  assert.equal(order.payments.length, 1);

  await prisma.product.update({ where: { id: sold.id }, data: { name: `${tag} renamed`, price: '150.00' } });
  const item = await prisma.orderItem.findUnique({ where: { id: order.items[0].id } });
  assert.equal(item.productName, sold.name);
  assert.equal(item.unitPrice.toString(), '100');

  // PostgreSQL 18 reports RESTRICT as 23001, which Prisma 6 passes through without a P-code.
  await assert.rejects(prisma.product.delete({ where: { id: sold.id } }), /order_items_productId_fkey/);
  await assert.rejects(prisma.user.delete({ where: { id: user.id } }), /orders_userId_fkey/);
});
