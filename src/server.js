import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { purgeOldConversations } from './services/ai/assistant.service.js';
import { purgeExpiredAuthData } from './services/session.service.js';
import { expireUnpaidOnlineOrders } from './services/payments/payment.service.js';

const EXPIRY_CHECK_MS = 5 * 60 * 1000;
const PURGE_CHECK_MS = 24 * 60 * 60 * 1000;

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

const expiryTimer = setInterval(() => {
  expireUnpaidOnlineOrders()
    .then((count) => {
      if (count > 0) console.log(`Cancelled ${count} unpaid online order(s)`);
    })
    .catch((error) => console.error('Unpaid order check failed:', error.message));
}, EXPIRY_CHECK_MS);
expiryTimer.unref();

const purgeTimer = setInterval(() => {
  purgeOldConversations().catch((error) => console.error('Chat cleanup failed:', error.message));
  purgeExpiredAuthData().catch((error) => console.error('Session cleanup failed:', error.message));
}, PURGE_CHECK_MS);
purgeTimer.unref();

const shutdown = () => {
  clearInterval(expiryTimer);
  clearInterval(purgeTimer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
