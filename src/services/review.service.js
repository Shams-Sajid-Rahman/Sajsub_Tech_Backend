import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { toSkipTake } from '../utils/pagination.js';

const findPublishedId = async (slug) => {
  const product = await prisma.product.findFirst({ where: { slug, status: 'PUBLISHED' }, select: { id: true } });
  if (!product) throw new ApiError(404, 'Product not found');
  return product.id;
};

export const listReviews = async (slug, pagination) => {
  const where = { productId: await findPublishedId(slug) };
  const [rows, total] = await prisma.$transaction([
    prisma.review.findMany({
      where,
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.review.count({ where }),
  ]);
  // Customers are shown by first name and last initial only.
  const items = rows.map(({ id, rating, comment, createdAt, user }) => ({
    id,
    rating,
    comment,
    createdAt,
    author: `${user.firstName} ${user.lastName[0]}.`,
  }));
  return { items, total };
};

// Only customers who received the product can review it, and a second review replaces the first.
export const saveReview = async (userId, slug, { rating, comment }) => {
  const productId = await findPublishedId(slug);
  const delivered = await prisma.orderItem.count({
    where: { productId, order: { userId, status: 'DELIVERED' } },
  });
  if (delivered === 0) throw new ApiError(403, 'You can review a product after it has been delivered to you');

  return prisma.$transaction(async (tx) => {
    const review = await tx.review.upsert({
      where: { productId_userId: { productId, userId } },
      update: { rating, comment: comment ?? null },
      create: { productId, userId, rating, comment },
    });
    const { _avg, _count } = await tx.review.aggregate({ where: { productId }, _avg: { rating: true }, _count: { _all: true } });
    await tx.product.update({
      where: { id: productId },
      data: { ratingAverage: _avg.rating.toFixed(1), ratingCount: _count._all },
    });
    return review;
  });
};
