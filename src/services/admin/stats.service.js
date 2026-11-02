import { prisma } from '../../config/prisma.js';

const SALES_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const NOT_ARCHIVED = { status: { not: 'ARCHIVED' } };
const OUT_OF_STOCK = { ...NOT_ARCHIVED, stockQuantity: 0 };
const lowStockWhere = () => ({
  ...NOT_ARCHIVED,
  stockQuantity: { gt: 0, lte: prisma.product.fields.lowStockAlert },
});
// Revenue is what has been collected and kept: refunds are subtracted, and money waiting to be refunded is left out.
const REVENUE_WHERE = { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, needsRefund: false };

const getDailySales = async () => {
  const start = new Date(Date.now() - (SALES_DAYS - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.$queryRaw`
    SELECT to_char(o."placedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, SUM(p."amount" - p."refundedAmount") AS revenue
    FROM "payments" p
    JOIN "orders" o ON o."id" = p."orderId"
    WHERE p."status" IN ('PAID', 'PARTIALLY_REFUNDED') AND NOT p."needsRefund" AND o."placedAt" >= ${start}
    GROUP BY day`;
  const byDay = new Map(rows.map(({ day, revenue }) => [day, Number(revenue)]));

  return Array.from({ length: SALES_DAYS }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS).toISOString().slice(0, 10);
    return { date, revenue: byDay.get(date) ?? 0 };
  });
};

export const getDashboardStats = async () => {
  const [
    totalCustomers,
    totalProducts,
    totalCategories,
    totalOrders,
    revenue,
    pendingOrders,
    lowStockProducts,
    outOfStockProducts,
    statusGroups,
    dailySales,
    recentOrders,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER', status: { not: 'DELETED' } } }),
    prisma.product.count({ where: NOT_ARCHIVED }),
    prisma.category.count({ where: { isActive: true } }),
    prisma.order.count(),
    prisma.payment.aggregate({ where: REVENUE_WHERE, _sum: { amount: true, refundedAmount: true } }),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.product.count({ where: lowStockWhere() }),
    prisma.product.count({ where: OUT_OF_STOCK }),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    getDailySales(),
    prisma.order.findMany({
      orderBy: { placedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalAmount: true,
        placedAt: true,
        user: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  return {
    totals: {
      totalCustomers,
      totalProducts,
      totalCategories,
      totalOrders,
      totalRevenue: (Number(revenue._sum.amount ?? 0) - Number(revenue._sum.refundedAmount ?? 0)).toFixed(2),
      pendingOrders,
      lowStockProducts,
      outOfStockProducts,
    },
    dailySales,
    ordersByStatus: statusGroups.map(({ status, _count }) => ({ status, count: _count._all })),
    recentOrders,
  };
};

export const getNotifications = async () => {
  const select = { id: true, name: true, stockQuantity: true };
  const [pendingOrders, refundsDue, outOfStock, lowStock] = await Promise.all([
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.payment.count({ where: { needsRefund: true } }),
    prisma.product.findMany({ where: OUT_OF_STOCK, select, orderBy: { name: 'asc' }, take: 5 }),
    prisma.product.findMany({ where: lowStockWhere(), select, orderBy: { stockQuantity: 'asc' }, take: 5 }),
  ]);
  return { pendingOrders, refundsDue, outOfStock, lowStock };
};
