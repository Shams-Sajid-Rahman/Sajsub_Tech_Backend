import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSkipTake } from '../../utils/pagination.js';
import { revokeUserSessions, SAFE_USER_SELECT } from '../session.service.js';

export const listUsers = async ({ search, role, status, ...pagination }) => {
  const where = {
    ...(role && { role }),
    ...(status && { status }),
    ...(search && {
      OR: ['email', 'firstName', 'lastName'].map((field) => ({ [field]: { contains: search, mode: 'insensitive' } })),
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: { ...SAFE_USER_SELECT, _count: { select: { orders: true } } },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total };
};

// Only customers can be changed here, so an admin can't lock out themselves or another admin.
export const updateUserStatus = async (id, status) => {
  const user = await prisma.user.findUnique({ where: { id }, select: { role: true, status: true } });
  if (!user) throw new ApiError(404, 'User not found');
  if (user.role !== 'CUSTOMER') throw new ApiError(403, 'Admin accounts cannot be changed here');
  if (user.status === 'DELETED') throw new ApiError(409, 'Deleted accounts cannot be changed');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id }, data: { status }, select: SAFE_USER_SELECT });
    if (status === 'SUSPENDED') await revokeUserSessions(tx, id);
    return updated;
  });
};
