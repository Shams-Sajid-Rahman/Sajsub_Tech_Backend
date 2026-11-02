import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';

if (!env.databaseUrl) {
  console.error('DATABASE_URL is not set. Copy backend/.env.example to backend/.env and fill it in.');
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
