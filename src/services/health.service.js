import { prisma } from '../config/prisma.js';

export const checkDatabase = async () => {
  await prisma.$queryRaw`SELECT 1`;
};
