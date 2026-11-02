import { prisma } from '../../config/prisma.js';
import { toSkipTake } from '../../utils/pagination.js';

// ---------- Banners ----------

export const listBanners = async ({ search, placement, isActive, ...pagination }) => {
  const where = {
    ...(placement && { placement }),
    ...(isActive !== undefined && { isActive }),
    ...(search && { title: { contains: search, mode: 'insensitive' } }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.banner.findMany({
      where,
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
      ...toSkipTake(pagination),
    }),
    prisma.banner.count({ where }),
  ]);
  return { items, total };
};

export const createBanner = (data) => prisma.banner.create({ data });
export const updateBanner = (id, data) => prisma.banner.update({ where: { id }, data });
export const deleteBanner = (id) => prisma.banner.delete({ where: { id } });

// ---------- Settings ----------

export const listSettings = async ({ search, ...pagination }) => {
  const where = search ? { key: { contains: search, mode: 'insensitive' } } : {};
  const [items, total] = await prisma.$transaction([
    prisma.siteSetting.findMany({ where, orderBy: { key: 'asc' }, ...toSkipTake(pagination) }),
    prisma.siteSetting.count({ where }),
  ]);
  return { items, total };
};

export const saveSetting = (key, data) =>
  prisma.siteSetting.upsert({ where: { key }, update: data, create: { key, ...data } });

export const deleteSetting = (key) => prisma.siteSetting.delete({ where: { key } });
