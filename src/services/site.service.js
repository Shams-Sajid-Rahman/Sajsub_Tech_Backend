import { prisma } from '../config/prisma.js';

// What the storefront needs on every page. Only settings marked public are included.
export const getSiteContent = async () => {
  const now = new Date();
  const [settings, banners] = await Promise.all([
    prisma.siteSetting.findMany({ where: { isPublic: true }, select: { key: true, value: true } }),
    prisma.banner.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      omit: { publicId: true, createdAt: true, updatedAt: true, isActive: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);
  return { settings: Object.fromEntries(settings.map(({ key, value }) => [key, value])), banners };
};
