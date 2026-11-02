import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';

const applyStockChange = async (tx, { productId, quantityChange, type, orderId, performedById, note }) => {
  // The stock condition and update are one atomic statement, so concurrent sales can't oversell.
  const { count } = await tx.product.updateMany({
    where: {
      id: productId,
      ...(quantityChange < 0 && { stockQuantity: { gte: -quantityChange } }),
    },
    data: { stockQuantity: { increment: quantityChange } },
  });

  if (count === 0) {
    const exists = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
    throw exists ? new ApiError(409, 'Insufficient stock') : new ApiError(404, 'Product not found');
  }

  const { stockQuantity: stockAfter } = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  return tx.inventoryTransaction.create({
    data: {
      productId,
      type,
      quantityChange,
      stockBefore: stockAfter - quantityChange,
      stockAfter,
      orderId,
      performedById,
      note,
    },
  });
};

// Changes stock and records it in the ledger together. Pass a transaction client
// to include this in a larger transaction, such as checkout.
export const adjustStock = (change, tx) => {
  if (!Number.isInteger(change.quantityChange) || change.quantityChange === 0) {
    throw new TypeError('quantityChange must be a non-zero integer');
  }
  if (tx) return applyStockChange(tx, change);
  return prisma.$transaction((client) => applyStockChange(client, change));
};
