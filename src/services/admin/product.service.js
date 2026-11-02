import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSkipTake } from '../../utils/pagination.js';
import { slugify } from '../../utils/slug.js';
import { destroyImages } from '../cloudinary.service.js';
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

export const createProduct = ({ initialStock, specifications = [], ...fields }, performedById) =>
  prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...fields,
        slug: fields.slug ?? slugify(fields.name),
        ...statusDates(fields.status),
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

export const updateProduct = (id, { specifications, ...fields }) =>
  prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw new ApiError(404, 'Product not found');
    if (specifications) await tx.productSpecification.deleteMany({ where: { productId: id } });
    return tx.product.update({
      where: { id },
      data: {
        ...fields,
        ...statusDates(fields.status, current.status),
        ...(specifications && { specifications: { create: specificationRows(specifications) } }),
      },
      include: DETAIL_INCLUDE,
    });
  });

// Products with orders or stock history are archived, so those records stay accurate.
// Anything else is really deleted, along with its stored images.
export const deleteProduct = async (id) => {
  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      status: true,
      images: { select: { publicId: true } },
      _count: { select: { orderItems: true, inventoryTransactions: true } },
    },
  });
  if (!product) throw new ApiError(404, 'Product not found');

  if (product._count.orderItems > 0 || product._count.inventoryTransactions > 0) {
    await prisma.product.update({
      where: { id },
      data: { status: 'ARCHIVED', ...statusDates('ARCHIVED', product.status) },
    });
    return { id, outcome: 'archived' };
  }

  await prisma.product.delete({ where: { id } });
  await destroyImages(product.images.map(({ publicId }) => publicId));
  return { id, outcome: 'deleted' };
};
