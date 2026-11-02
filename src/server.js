import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';

try {
  await prisma.$connect();
} catch (error) {
  console.error('Could not connect to PostgreSQL. Check DATABASE_URL in backend/.env.');
  console.error(error.message);
  process.exit(1);
}

const server = app.listen(env.port, () => {
  console.log(`Sajsub Tech API listening on http://localhost:${env.port}`);
});

const shutdown = () => {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
