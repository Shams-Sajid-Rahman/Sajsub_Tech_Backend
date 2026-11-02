import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { toSkipTake } from '../utils/pagination.js';

const PUBLIC_SELECT = { id: true, name: true, slug: true, description: true, logoUrl: true };

export const listBrands = async (pagination) => {
  const where = { isActive: true };
  const [brands, total] = await prisma.$transaction([
    prisma.brand.findMany({ where, select: PUBLIC_SELECT, orderBy: { name: 'asc' }, ...toSkipTake(pagination) }),
    prisma.brand.count({ where }),
  ]);
  return { brands, total };
};

export const getBrandBySlug = async (slug) => {
  const brand = await prisma.brand.findFirst({ where: { slug, isActive: true }, select: PUBLIC_SELECT });
  if (!brand) throw new ApiError(404, 'Brand not found');
  return brand;
};
