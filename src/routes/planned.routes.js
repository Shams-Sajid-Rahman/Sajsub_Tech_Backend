import { Router } from 'express';
import { sendError } from '../utils/response.js';

// Placeholder for a route group whose endpoints need authentication, built in a later phase.
export const plannedRoutes = (group) => {
  const router = Router();
  router.use((req, res) => sendError(res, 501, `The ${group} API is not implemented yet`));
  return router;
};
