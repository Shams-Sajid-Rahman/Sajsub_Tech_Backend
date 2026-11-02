import { prisma } from '../../config/prisma.js';
import { getProductBySlug, listProducts, PUBLIC_WHERE } from '../product.service.js';

// Read-only product lookups for the assistant. Everything goes through the same services as
// the storefront, so drafts and archived products stay hidden. Nothing here writes.

const DEFAULT_LIMIT = 6;
const COMPARISON_DETAIL_FIELDS = (detail) => ({
  description: detail.shortDescription ?? detail.description ?? null,
  specifications: detail.specifications,
});

// The fields the model sees. Pictures and links are added to the customer's cards separately.
const toToolProduct = (product) => ({
  name: product.name,
  slug: product.slug,
  brand: product.brand.name,
  category: product.category.name,
  currency: 'BDT',
  price: product.price,
  discountPrice: product.discountPrice,
  effectivePrice: product.effectivePrice,
  savings: product.discountPrice ? (Number(product.price) - Number(product.discountPrice)).toFixed(2) : null,
  discountPercent: product.discountPercent,
  inStock: product.inStock,
  ratingAverage: product.ratingCount > 0 ? product.ratingAverage : null,
  ratingCount: product.ratingCount,
});

const search = async (query) => {
  const { products, total } = await listProducts({ page: 1, limit: DEFAULT_LIMIT, sort: 'rating', ...query });
  return { products, total };
};

// Exact name or slug first, then a word search. An unclear reference is reported rather than guessed.
const resolveProduct = async (reference) => {
  const exact = await prisma.product.findFirst({
    where: { ...PUBLIC_WHERE, OR: [{ slug: reference }, { name: { equals: reference, mode: 'insensitive' } }] },
    select: { slug: true },
  });
  if (exact) return { product: await getProductBySlug(exact.slug) };

  const { products } = await search({ search: reference, limit: 5 });
  if (products.length === 1) return { product: await getProductBySlug(products[0].slug) };
  if (products.length > 1) return { ambiguous: products.map(({ name }) => name) };
  return {};
};

const unresolved = (reference, { ambiguous }) =>
  ambiguous
    ? { found: false, reason: 'ambiguous', reference, matches: ambiguous }
    : { found: false, reason: 'not_found', reference };

// Runs a lookup for one product, and reports not-found or several matches in a uniform way.
const withProduct = async ({ product: reference }, build) => {
  const resolved = await resolveProduct(reference);
  if (!resolved.product) return { result: unresolved(reference, resolved) };
  return { result: { found: true, ...(await build(resolved.product)) }, cards: [resolved.product] };
};

const resolveCategory = async (reference) => {
  const words = reference.trim().split(/\s+/);
  return prisma.category.findFirst({
    where: {
      isActive: true,
      OR: [
        { slug: reference },
        { AND: words.map((word) => ({ name: { contains: word, mode: 'insensitive' } })) },
      ],
    },
    select: { name: true, slug: true },
    orderBy: { sortOrder: 'asc' },
  });
};

const listCategoryNames = async () =>
  (await prisma.category.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } })).map(({ name }) => name);

const resolveBrand = (reference) =>
  prisma.brand.findFirst({
    where: { isActive: true, OR: [{ slug: reference }, { name: { contains: reference, mode: 'insensitive' } }] },
    select: { name: true, slug: true },
  });

const listResult = ({ products, total }) => ({
  result: { found: products.length > 0, total, products: products.map(toToolProduct) },
  cards: products,
});

// Turns optional category and brand names into filters, or an answer explaining what doesn't exist.
const resolveFilters = async ({ category, brand }) => {
  const filters = {};
  if (category) {
    const match = await resolveCategory(category);
    if (!match) return { problem: { found: false, reason: 'unknown_category', category, availableCategories: await listCategoryNames() } };
    filters.category = match.slug;
  }
  if (brand) {
    const match = await resolveBrand(brand);
    if (!match) return { problem: { found: false, reason: 'unknown_brand', brand } };
    filters.brand = match.slug;
  }
  return { filters };
};

export const searchProducts = async ({ query, onSaleOnly, inStockOnly, limit }) =>
  listResult(
    await search({
      ...(query && { search: query }),
      ...(onSaleOnly && { onSale: true }),
      ...(inStockOnly && { inStock: true }),
      ...(limit && { limit }),
    }),
  );

export const getProductDetails = (args) =>
  withProduct(args, async (product) => ({
    ...toToolProduct(product),
    stockLeft: product.stockLeft,
    shortDescription: product.shortDescription,
    description: product.description,
    specifications: product.specifications,
  }));

export const getProductPrice = (args) =>
  withProduct(args, async ({ name, price, discountPrice, effectivePrice, discountPercent }) => ({
    name,
    currency: 'BDT',
    price,
    discountPrice,
    effectivePrice,
    savings: discountPrice ? (Number(price) - Number(discountPrice)).toFixed(2) : null,
    discountPercent,
  }));

export const checkProductAvailability = (args) =>
  withProduct(args, async ({ name, inStock }) => ({ name, inStock }));

export const getStockQuantity = (args) =>
  withProduct(args, async ({ id, name, inStock }) => {
    const { stockQuantity } = await prisma.product.findUniqueOrThrow({ where: { id }, select: { stockQuantity: true } });
    return { name, inStock, stockQuantity };
  });

export const getProductsByCategory = async ({ category, inStockOnly, limit }) => {
  const { filters, problem } = await resolveFilters({ category });
  if (problem) return { result: problem };
  return listResult(await search({ ...filters, ...(inStockOnly && { inStock: true }), ...(limit && { limit }) }));
};

export const filterProductsByPrice = async ({ minPrice, maxPrice, category, brand, inStockOnly, limit }) => {
  const { filters, problem } = await resolveFilters({ category, brand });
  if (problem) return { result: problem };
  return listResult(
    await search({
      ...filters,
      ...(minPrice !== undefined && { minPrice }),
      ...(maxPrice !== undefined && { maxPrice }),
      ...(inStockOnly && { inStock: true }),
      ...(limit && { limit }),
      sort: 'price_asc',
    }),
  );
};

export const compareProducts = async ({ products }) => {
  const resolved = await Promise.all(products.map(async (reference) => ({ reference, ...(await resolveProduct(reference)) })));
  const found = resolved.filter(({ product }) => product).map(({ product }) => product);
  return {
    result: {
      found: found.length > 0,
      products: found.map((product) => ({ ...toToolProduct(product), ...COMPARISON_DETAIL_FIELDS(product) })),
      notFound: resolved.filter(({ product }) => !product).map((entry) => unresolved(entry.reference, entry)),
    },
    cards: found,
  };
};

// Candidates only, ranked by rating and in stock. The model explains the fit using their specifications.
export const recommendProducts = async ({ keywords, category, brand, maxPrice, limit = 4 }) => {
  const { filters, problem } = await resolveFilters({ category, brand });
  if (problem) return { result: problem };

  const base = { ...filters, inStock: true, limit, ...(maxPrice !== undefined && { maxPrice }) };
  let matches = await search({ ...base, ...(keywords && { search: keywords }) });
  // A use like "programming" rarely appears in a product's text, so fall back to the other filters.
  const keywordsMatched = !keywords || matches.products.length > 0;
  if (!keywordsMatched && (category || brand || maxPrice !== undefined)) matches = await search(base);

  const details = await Promise.all(matches.products.map(({ slug }) => getProductBySlug(slug)));
  return {
    result: {
      found: details.length > 0,
      keywordsMatched,
      products: details.map((product) => ({ ...toToolProduct(product), ...COMPARISON_DETAIL_FIELDS(product) })),
    },
    cards: matches.products,
  };
};
