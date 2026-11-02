import { checkDatabase } from '../services/health.service.js';
import { sendError, sendSuccess } from '../utils/response.js';

export const getHealth = (req, res) => {
  sendSuccess(res, {
    status: 'ok',
    service: 'sajsub-tech-api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};

export const getDatabaseHealth = async (req, res) => {
  try {
    await checkDatabase();
    sendSuccess(res, { status: 'ok', database: 'connected' });
  } catch (error) {
    // Details stay in the server log: Prisma errors can reveal connection info.
    console.error('Database health check failed:', error.message);
    sendError(res, 503, 'Database unavailable');
  }
};
