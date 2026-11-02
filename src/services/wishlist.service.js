import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { CARD_INCLUDE, isPurchasable, toPublicProduct } from './product.service.js';

export const getWishlist = async (userId) => {
  const wishlist = await prisma.wishlist.findUnique({
    where: { userId },
    include: { items: { orderBy: { createdAt: 'desc' }, include: { product: { include: CARD_INCLUDE } } } },
  });
  return (wishlist?.items ?? [])
    .filter(({ product }) => isPurchasable(product))
    .map(({ product }) => toPublicProduct(product));
};

export const addWishlistItem = async (userId, productId) => {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: CARD_INCLUDE });
  if (!product || !isPurchasable(product)) throw new ApiError(404, 'Product not found');
  const wishlist = await prisma.wishlist.upsert({ where: { userId }, update: {}, create: { userId } });
  await prisma.wishlistItem.upsert({
    where: { wishlistId_productId: { wishlistId: wishlist.id, productId } },
    update: {},
    create: { wishlistId: wishlist.id, productId },
  });
  return getWishlist(userId);
};

export const removeWishlistItem = async (userId, productId) => {
  await prisma.wishlistItem.deleteMany({ where: { productId, wishlist: { userId } } });
  return getWishlist(userId);
};
