import { prisma } from '../../config/prisma.js';
import { toSkipTake } from '../../utils/pagination.js';

export const logAudit = ({ actorId, ipAddress, ...entry }) =>
  prisma.auditLog.create({ data: { actorId, ipAddress, ...entry } });

export const listAuditLogs = async ({ search, entityType, ...pagination }) => {
  const where = {
    ...(entityType && { entityType }),
    ...(search && { action: { contains: search, mode: 'insensitive' } }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total };
};

export const listLoginLogs = async ({ search, success, ...pagination }) => {
  const where = {
    ...(success !== undefined && { success }),
    ...(search && { email: { contains: search, mode: 'insensitive' } }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.loginLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(pagination) }),
    prisma.loginLog.count({ where }),
  ]);
  return { items, total };
};

export const listInventoryTransactions = async ({ productId, type, ...pagination }) => {
  const where = { ...(productId && { productId }), ...(type && { type }) };
  const [items, total] = await prisma.$transaction([
    prisma.inventoryTransaction.findMany({
      where,
      include: {
        product: { select: { name: true, sku: true } },
        performedBy: { select: { email: true } },
        order: { select: { orderNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(pagination),
    }),
    prisma.inventoryTransaction.count({ where }),
  ]);
  return { items, total };
};
