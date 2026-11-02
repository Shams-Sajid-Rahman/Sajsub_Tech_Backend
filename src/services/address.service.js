import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';

const MAX_ADDRESSES = 20;

export const listAddresses = (userId) =>
  prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });

// The first address becomes the default automatically.
export const createAddress = (userId, { isDefault, ...fields }) =>
  prisma.$transaction(async (tx) => {
    const count = await tx.address.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) throw new ApiError(400, `You can save at most ${MAX_ADDRESSES} addresses`);
    const makeDefault = isDefault || count === 0;
    if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    return tx.address.create({ data: { ...fields, userId, isDefault: makeDefault } });
  });

// Past orders keep their own copy of the address, so deleting one here doesn't change them.
export const deleteAddress = (userId, id) =>
  prisma.$transaction(async (tx) => {
    const address = await tx.address.findFirst({ where: { id, userId } });
    if (!address) throw new ApiError(404, 'Address not found');
    await tx.address.delete({ where: { id } });
    if (address.isDefault) {
      const next = await tx.address.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { id };
  });
