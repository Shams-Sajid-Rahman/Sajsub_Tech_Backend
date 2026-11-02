import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSkipTake } from '../../utils/pagination.js';
import { slugify } from '../../utils/slug.js';
import { adjustStock } from '../inventory.service.js';

const DETAIL_INCLUDE = {
  category: { select: { id: true, name: true } },
  brand: { select: { id: true, name: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  specifications: { orderBy: { sortOrder: 'asc' } },
};

const stockWhere = {
  in: () => ({ stockQuantity: { gt: prisma.product.fields.lowStockAlert } }),
  low: () => ({ stockQuantity: { gt: 0, lte: prisma.product.fields.lowStockAlert } }),
  out: () => ({ stockQuantity: 0 }),
};

export const listAdminProducts = async ({ search, status, categoryId, brandId, stock, ...pagination }) => {
  const where = {
    ...(status && { status }),
    ...(categoryId && { categoryId }),
    ...(brandId && { brandId }),
    ...(stock && stockWhere[stock]()),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.product.findMany({ where, include: DETAIL_INCLUDE, orderBy: { createdAt: 'desc' }, ...toSkipTake(pagination) }),
    prisma.product.count({ where }),
  ]);
  return { items, total };
};

export const getAdminProduct = async (id) => {
  const product = await prisma.product.findUnique({ where: { id }, include: DETAIL_INCLUDE });
  if (!product) throw new ApiError(404, 'Product not found');
  return product;
};

const imageRows = (images) =>
  images.map(({ url, altText }, sortOrder) => ({ url, altText, sortOrder, isPrimary: sortOrder === 0 }));
const specificationRows = (specifications) =>
  specifications.map((specification, sortOrder) => ({ ...specification, sortOrder }));

// Dates only change when the status does, so editing a product keeps its publish date.
const statusDates = (status, previousStatus) => {
  if (status === previousStatus) return {};
  if (status === 'PUBLISHED') return { publishedAt: new Date(), archivedAt: null };
  if (status === 'ARCHIVED') return { archivedAt: new Date() };
  if (status === 'DRAFT') return { archivedAt: null };
  return {};
};

export const createProduct = ({ initialStock, images = [], specifications = [], ...fields }, performedById) =>
  prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...fields,
        slug: fields.slug ?? slugify(fields.name),
        ...statusDates(fields.status),
        images: { create: imageRows(images) },
        specifications: { create: specificationRows(specifications) },
      },
    });
    if (initialStock > 0) {
      await adjustStock(
        { productId: product.id, quantityChange: initialStock, type: 'INITIAL_STOCK', performedById, note: 'Product created' },
        tx,
      );
    }
    return tx.product.findUnique({ where: { id: product.id }, include: DETAIL_INCLUDE });
  });

export const updateProduct = (id, { images, specifications, ...fields }) =>
  prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw new ApiError(404, 'Product not found');
    if (images) await tx.productImage.deleteMany({ where: { productId: id } });
    if (specifications) await tx.productSpecification.deleteMany({ where: { productId: id } });
    return tx.product.update({
      where: { id },
      data: {
        ...fields,
        ...statusDates(fields.status, current.status),
        ...(images && { images: { create: imageRows(images) } }),
        ...(specifications && { specifications: { create: specificationRows(specifications) } }),
      },
      include: DETAIL_INCLUDE,
    });
  });

// Products are archived, never deleted, so order history stays intact.
export const archiveProduct = (id) =>
  prisma.product.update({ where: { id }, data: { status: 'ARCHIVED', ...statusDates('ARCHIVED') } });
