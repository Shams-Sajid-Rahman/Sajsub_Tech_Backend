import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createAdmin } from './admin.js';

const prisma = new PrismaClient();

try {
  const { email, created } = await createAdmin(prisma);
  console.log(created ? `Admin created: ${email}` : `Admin already exists: ${email}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
