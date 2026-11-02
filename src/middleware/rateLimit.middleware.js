import { rateLimit } from 'express-rate-limit';
import { sendError } from '../utils/response.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const createRateLimiter = ({ max, windowMs = FIFTEEN_MINUTES, skipSuccessfulRequests = false }) =>
  rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => sendError(res, 429, 'Too many requests. Please try again later.'),
  });

export const apiLimiter = createRateLimiter({ max: 300 });

// Counts failures only, to slow password guessing without affecting normal logins.
export const loginLimiter = createRateLimiter({ max: 10, skipSuccessfulRequests: true });

// Registration and password reset requests.
export const accountLimiter = createRateLimiter({ max: 20 });
