import { checkDatabase } from '../services/health.service.js';

export const getHealth = (req, res) => {
  res.json({
    status: 'ok',
    service: 'sajsub-tech-api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};

export const getDatabaseHealth = async (req, res) => {
  try {
    await checkDatabase();
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    // Details stay in the server log: Prisma errors can reveal connection info.
    console.error('Database health check failed:', error.message);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
};
