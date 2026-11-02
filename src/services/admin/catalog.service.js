import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSkipTake } from '../../utils/pagination.js';
import { slugify } from '../../utils/slug.js';

const listActivable = async (model, { search, isActive, ...pagination }, options) => {
  const where = {
    ...(isActive !== undefined && { isActive }),
    ...(search && { name: { contains: search, mode: 'insensitive' } }),
  };
  const [items, total] = await prisma.$transaction([
    model.findMany({ where, ...options, ...toSkipTake(pagination) }),
    model.count({ where }),
  ]);
  return { items, total };
};

// ---------- Categories ----------

export const listAdminCategories = (query) =>
  listActivable(prisma.category, query, {
    include: { parent: { select: { id: true, name: true } }, _count: { select: { products: true } } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

const assertNoCycle = async (id, parentId) => {
  let current = parentId;
  while (current) {
    if (current === id) throw new ApiError(400, 'A category cannot be placed inside itself');
    const parent = await prisma.category.findUnique({ where: { id: current }, select: { parentId: true } });
    current = parent?.parentId;
  }
};

export const createCategory = (data) =>
  prisma.category.create({ data: { ...data, slug: data.slug ?? slugify(data.name) } });

export const updateCategory = async (id, data) => {
  if (data.parentId) await assertNoCycle(id, data.parentId);
  return prisma.category.update({ where: { id }, data });
};

export const archiveCategory = (id) => prisma.category.update({ where: { id }, data: { isActive: false } });

// ---------- Brands ----------

export const listAdminBrands = (query) =>
  listActivable(prisma.brand, query, {
    include: { _count: { select: { products: true } } },
    orderBy: { name: 'asc' },
  });

export const createBrand = (data) => prisma.brand.create({ data: { ...data, slug: data.slug ?? slugify(data.name) } });

export const updateBrand = (id, data) => prisma.brand.update({ where: { id }, data });

export const archiveBrand = (id) => prisma.brand.update({ where: { id }, data: { isActive: false } });
