import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { toSkipTake } from '../utils/pagination.js';

const PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  icon: true,
  imageUrl: true,
  parentId: true,
  showInMenu: true,
  isFeatured: true,
};

export const listCategories = async ({ menu, featured, ...pagination }) => {
  const where = {
    isActive: true,
    ...(menu !== undefined && { showInMenu: menu }),
    ...(featured !== undefined && { isFeatured: featured }),
  };
  const [categories, total] = await prisma.$transaction([
    prisma.category.findMany({
      where,
      select: PUBLIC_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      ...toSkipTake(pagination),
    }),
    prisma.category.count({ where }),
  ]);
  return { categories, total };
};

export const getCategoryBySlug = async (slug) => {
  const category = await prisma.category.findFirst({
    where: { slug, isActive: true },
    select: {
      ...PUBLIC_SELECT,
      children: {
        where: { isActive: true },
        select: PUBLIC_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      },
    },
  });
  if (!category) throw new ApiError(404, 'Category not found');
  return category;
};
