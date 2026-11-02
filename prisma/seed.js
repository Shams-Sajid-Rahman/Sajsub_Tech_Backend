// Development data, safe to re-run. Refuses to run in production:
// production admins come from `npm run admin:create` and products from the dashboard.
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { adjustStock } from '../src/services/inventory.service.js';
import { createAdmin } from './admin.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed sample data in production.');
  process.exit(1);
}

// Sidebar and "Shop by Category" entries from docs/design/homepage-reference.png
const ROOT_CATEGORIES = [
  { name: 'Electronics', slug: 'electronics', icon: 'tablet', showInMenu: true },
  { name: 'Fashion & Apparel', slug: 'fashion-apparel', icon: 'shirt', showInMenu: true, isFeatured: true },
  { name: 'Home & Living', slug: 'home-living', icon: 'house', showInMenu: true },
  { name: 'Sports & Outdoors', slug: 'sports-outdoors', icon: 'volleyball', showInMenu: true },
  { name: 'Beauty & Personal Care', slug: 'beauty-personal-care', icon: 'sparkles', showInMenu: true },
  { name: 'Health & Wellness', slug: 'health-wellness', icon: 'heart', showInMenu: true },
  { name: 'Books & Stationery', slug: 'books-stationery', icon: 'book-open', showInMenu: true },
  { name: 'Toys & Games', slug: 'toys-games', icon: 'puzzle', showInMenu: true },
];

const CHILD_CATEGORIES = [
  { name: 'Laptops & Computers', slug: 'laptops-computers', parent: 'electronics' },
  { name: 'Smartphones & Accessories', slug: 'smartphones-accessories', parent: 'electronics' },
  { name: 'Audio & Headphones', slug: 'audio-headphones', parent: 'electronics' },
  { name: 'Smartwatches & Wearables', slug: 'smartwatches-wearables', parent: 'electronics' },
  { name: 'Gaming & Consoles', slug: 'gaming-consoles', parent: 'electronics' },
  { name: 'Cameras & Photography', slug: 'cameras-photography', parent: 'electronics' },
  { name: 'Home Appliances', slug: 'home-appliances', parent: 'home-living' },
];

const BRANDS = [
  { name: 'Apple', slug: 'apple' },
  { name: 'Sony', slug: 'sony' },
];

const PRODUCTS = [
  {
    name: 'MacBook Air M2', slug: 'macbook-air-m2', sku: 'DEV-APL-MBA-M2', category: 'laptops-computers', brand: 'apple',
    price: '1249.00', discountPrice: '999.00', ratingAverage: '4.8', ratingCount: 1200, stock: 25,
    specifications: { Chip: 'Apple M2', Display: '13.6-inch' },
  },
  {
    name: 'AirPods Pro (2nd Gen)', slug: 'airpods-pro-2nd-gen', sku: 'DEV-APL-APP-2', category: 'audio-headphones', brand: 'apple',
    price: '299.00', discountPrice: '249.00', ratingAverage: '4.7', ratingCount: 856, stock: 60,
    specifications: { Type: 'In-ear', 'Noise cancellation': 'Active' },
  },
  {
    name: 'iPhone 16', slug: 'iphone-16', sku: 'DEV-APL-IP16', category: 'smartphones-accessories', brand: 'apple',
    price: '1199.00', discountPrice: '899.00', ratingAverage: '4.8', ratingCount: 722, stock: 40,
    specifications: { Display: '6.1-inch', Chip: 'Apple A18' },
  },
  {
    name: 'Apple Watch Series 10', slug: 'apple-watch-series-10', sku: 'DEV-APL-AWS10', category: 'smartwatches-wearables', brand: 'apple',
    price: '489.00', discountPrice: '399.00', ratingAverage: '4.7', ratingCount: 890, stock: 35,
    specifications: { 'Water resistance': '50 m' },
  },
  {
    name: 'PlayStation 5 DualSense', slug: 'playstation-5-dualsense', sku: 'DEV-SNY-DS5', category: 'gaming-consoles', brand: 'sony',
    price: '69.99', discountPrice: null, ratingAverage: '4.8', ratingCount: 960, stock: 80,
    specifications: { Connectivity: 'Bluetooth, USB-C' },
  },
  {
    name: 'Sony WH-1000XM5', slug: 'sony-wh-1000xm5', sku: 'DEV-SNY-XM5', category: 'audio-headphones', brand: 'sony',
    price: '349.00', discountPrice: null, ratingAverage: '4.8', ratingCount: 412, stock: 30,
    specifications: { Type: 'Over-ear', 'Noise cancellation': 'Active' },
  },
];

const SETTINGS = [
  { key: 'free_shipping_threshold', value: 50, description: 'Order total for free shipping', isPublic: true },
  { key: 'return_policy_days', value: 30, description: 'Return window in days', isPublic: true },
  { key: 'currency', value: 'USD', description: 'Store currency', isPublic: true },
];

const HERO_BANNER = {
  placement: 'HERO',
  badgeText: 'New Arrival',
  title: 'Upgrade Your Life with',
  highlight: 'Sajsub Tech',
  subtitle: 'Smart Products. Better Tomorrow.',
  buttonText: 'Shop Now',
  linkUrl: '/shop',
};

const ANNOUNCEMENT_BANNERS = [
  { placement: 'ANNOUNCEMENT', title: 'Free Shipping on Orders Over $50!', sortOrder: 0 },
  { placement: 'ANNOUNCEMENT', title: '30% Off This Weekend Only', sortOrder: 1 },
];

const upsertBySlug = (model, { slug, ...data }) =>
  model.upsert({ where: { slug }, update: data, create: { slug, ...data } });

const seedCategories = async () => {
  const ids = {};
  for (const [index, category] of ROOT_CATEGORIES.entries()) {
    const { id } = await upsertBySlug(prisma.category, { ...category, sortOrder: index });
    ids[category.slug] = id;
  }
  for (const [index, { parent, ...category }] of CHILD_CATEGORIES.entries()) {
    const { id } = await upsertBySlug(prisma.category, {
      ...category,
      parentId: ids[parent],
      isFeatured: true,
      sortOrder: index,
    });
    ids[category.slug] = id;
  }
  return ids;
};

const seedBrands = async () => {
  const ids = {};
  for (const brand of BRANDS) {
    const { id } = await upsertBySlug(prisma.brand, brand);
    ids[brand.slug] = id;
  }
  return ids;
};

const seedProducts = async (categoryIds, brandIds) => {
  for (const { category, brand, stock, specifications, ...fields } of PRODUCTS) {
    const data = {
      ...fields,
      categoryId: categoryIds[category],
      brandId: brandIds[brand],
      status: 'PUBLISHED',
      isFeatured: true,
    };
    // Stock is only set on first creation, so re-seeding keeps the ledger accurate.
    const existing = await prisma.product.findUnique({ where: { sku: fields.sku }, select: { id: true } });
    if (existing) {
      await prisma.product.update({ where: { id: existing.id }, data });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          ...data,
          publishedAt: new Date(),
          specifications: {
            create: Object.entries(specifications).map(([name, value], sortOrder) => ({ name, value, sortOrder })),
          },
        },
      });
      await adjustStock(
        { productId: product.id, quantityChange: stock, type: 'INITIAL_STOCK', note: 'Development seed' },
        tx,
      );
    });
  }
};

const seedSettings = async () => {
  for (const { key, ...data } of SETTINGS) {
    await prisma.siteSetting.upsert({ where: { key }, update: data, create: { key, ...data } });
  }
};

// Banners have no natural unique key, so they are only added when none exist for a placement.
const seedBanners = async () => {
  if ((await prisma.banner.count({ where: { placement: 'HERO' } })) === 0) {
    await prisma.banner.create({ data: HERO_BANNER });
  }
  if ((await prisma.banner.count({ where: { placement: 'ANNOUNCEMENT' } })) === 0) {
    await prisma.banner.createMany({ data: ANNOUNCEMENT_BANNERS });
  }
};

try {
  const categoryIds = await seedCategories();
  const brandIds = await seedBrands();
  await seedProducts(categoryIds, brandIds);
  await seedSettings();
  await seedBanners();
  const { email, created } = await createAdmin(prisma);
  console.log(`Seed complete. Admin ${created ? 'created' : 'already exists'}: ${email}`);
} catch (error) {
  console.error('Seed failed:', error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
