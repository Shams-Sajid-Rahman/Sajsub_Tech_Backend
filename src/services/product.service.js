import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { toSkipTake } from '../utils/pagination.js';

// Customers only see published products in active categories and brands.
export const PUBLIC_WHERE = {
  status: 'PUBLISHED',
  category: { isActive: true },
  brand: { isActive: true },
};

const LIST_INCLUDE = {
  category: { select: { name: true, slug: true, isActive: true } },
  brand: { select: { name: true, slug: true, isActive: true } },
  images: { where: { isPrimary: true }, take: 1 },
};

const SORTS = {
  newest: [{ createdAt: 'desc' }, { id: 'asc' }],
  oldest: [{ createdAt: 'asc' }, { id: 'asc' }],
  name: [{ name: 'asc' }, { id: 'asc' }],
  rating: [{ ratingAverage: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }],
};

const effectivePrice = ({ price, discountPrice }) => discountPrice ?? price;

export const CARD_INCLUDE = LIST_INCLUDE;

// Publication and stock are separate: an out-of-stock product can stay visible.
export const isPurchasable = ({ status, category, brand }) =>
  status === 'PUBLISHED' && category.isActive && brand.isActive;

export const toPublicProduct = ({ images, stockQuantity, ...product }) => {
  const salePrice = effectivePrice(product);
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    shortDescription: product.shortDescription,
    price: product.price.toFixed(2),
    discountPrice: product.discountPrice?.toFixed(2) ?? null,
    effectivePrice: salePrice.toFixed(2),
    discountPercent:
      product.discountPrice && product.price.gt(0)
        ? product.price.minus(salePrice).div(product.price).times(100).round().toNumber()
        : 0,
    inStock: stockQuantity > 0,
    isFeatured: product.isFeatured,
    ratingAverage: product.ratingAverage.toNumber(),
    ratingCount: product.ratingCount,
    category: { name: product.category.name, slug: product.category.slug },
    brand: { name: product.brand.name, slug: product.brand.slug },
    stockLeft: stockQuantity > 0 && stockQuantity <= product.lowStockAlert ? stockQuantity : null,
    primaryImage: images[0] ? { url: images[0].url, altText: images[0].altText } : null,
  };
};

const priceAtLeast = (value) => ({
  OR: [{ discountPrice: { gte: value } }, { discountPrice: null, price: { gte: value } }],
});

const priceAtMost = (value) => ({
  OR: [{ discountPrice: { lte: value } }, { discountPrice: null, price: { lte: value } }],
});

const buildWhere = ({ search, category, brand, featured, minPrice, maxPrice, inStock, onSale }) => {
  const conditions = [PUBLIC_WHERE];
  if (search) {
    // Every word has to match somewhere, so "sony headphones" finds Sony products in the audio category.
    for (const word of search.trim().split(/\s+/)) {
      conditions.push({
        OR: [
          { name: { contains: word, mode: 'insensitive' } },
          { shortDescription: { contains: word, mode: 'insensitive' } },
          { brand: { name: { contains: word, mode: 'insensitive' } } },
          { category: { name: { contains: word, mode: 'insensitive' } } },
        ],
      });
    }
  }
  // A parent category also includes products from its subcategories.
  if (category) conditions.push({ category: { OR: [{ slug: category }, { parent: { slug: category } }] } });
  if (brand) conditions.push({ brand: { slug: brand } });
  if (featured !== undefined) conditions.push({ isFeatured: featured });
  if (minPrice !== undefined) conditions.push(priceAtLeast(minPrice));
  if (maxPrice !== undefined) conditions.push(priceAtMost(maxPrice));
  if (inStock !== undefined) conditions.push({ stockQuantity: inStock ? { gt: 0 } : 0 });
  if (onSale) conditions.push({ discountPrice: { not: null } });
  return { AND: conditions };
};

// The customer's price is discountPrice ?? price, which Prisma can't order by, so
// price sorts rank matching ids in memory. Replace with SQL if the catalog grows large.
const findPriceSortedPage = async (where, query) => {
  const rows = await prisma.product.findMany({
    where,
    select: { id: true, price: true, discountPrice: true },
  });
  const direction = query.sort === 'price_asc' ? 1 : -1;
  const { skip, take } = toSkipTake(query);
  const ids = rows
    .sort((a, b) => direction * effectivePrice(a).comparedTo(effectivePrice(b)) || a.id.localeCompare(b.id))
    .slice(skip, skip + take)
    .map(({ id }) => id);

  const products = await prisma.product.findMany({ where: { id: { in: ids } }, include: LIST_INCLUDE });
  const byId = new Map(products.map((product) => [product.id, product]));
  return { products: ids.map((id) => byId.get(id)), total: rows.length };
};

export const listProducts = async (query) => {
  const where = buildWhere(query);

  if (query.sort === 'price_asc' || query.sort === 'price_desc') {
    const { products, total } = await findPriceSortedPage(where, query);
    return { products: products.map(toPublicProduct), total };
  }

  const [products, total] = await prisma.$transaction([
    prisma.product.findMany({ where, include: LIST_INCLUDE, orderBy: SORTS[query.sort], ...toSkipTake(query) }),
    prisma.product.count({ where }),
  ]);
  return { products: products.map(toPublicProduct), total };
};

const RELATED_LIMIT = 6;

export const getRelatedProducts = async (slug) => {
  const product = await prisma.product.findFirst({
    where: { ...PUBLIC_WHERE, slug },
    select: { id: true, categoryId: true, category: { select: { parentId: true } } },
  });
  if (!product) throw new ApiError(404, 'Product not found');
  const { parentId } = product.category;
  const related = await prisma.product.findMany({
    where: {
      ...PUBLIC_WHERE,
      id: { not: product.id },
      OR: [{ categoryId: product.categoryId }, ...(parentId ? [{ category: { isActive: true, parentId } }] : [])],
    },
    include: LIST_INCLUDE,
    orderBy: [{ ratingAverage: 'desc' }, { id: 'asc' }],
    take: RELATED_LIMIT,
  });
  return related.map(toPublicProduct);
};

export const getProductBySlug = async (slug) => {
  const product = await prisma.product.findFirst({
    where: { ...PUBLIC_WHERE, slug },
    include: {
      ...LIST_INCLUDE,
      images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      specifications: { orderBy: { sortOrder: 'asc' }, select: { name: true, value: true } },
    },
  });
  if (!product) throw new ApiError(404, 'Product not found');

  return {
    ...toPublicProduct(product),
    description: product.description,
    images: product.images.map(({ url, altText, isPrimary }) => ({ url, altText, isPrimary })),
    specifications: product.specifications,
  };
};
