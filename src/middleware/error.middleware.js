import { Prisma } from '@prisma/client';
import { ApiError } from '../utils/ApiError.js';
import { sendError } from '../utils/response.js';

const PRISMA_ERRORS = {
  P2002: [409, 'A record with this value already exists'],
  P2003: [409, 'This record is linked to other data'],
  P2023: [400, 'Invalid identifier'],
  P2025: [404, 'Record not found'],
  P1001: [503, 'Service temporarily unavailable'],
  P1002: [503, 'Service temporarily unavailable'],
  P1008: [503, 'Service temporarily unavailable'],
  P1017: [503, 'Service temporarily unavailable'],
};

const BODY_PARSER_ERRORS = {
  'entity.parse.failed': [400, 'Request body contains invalid JSON'],
  'entity.too.large': [413, 'Request body is too large'],
};

const toClientError = (err) => {
  if (err instanceof ApiError) return [err.status, err.message, err.errors];
  if (BODY_PARSER_ERRORS[err.type]) return BODY_PARSER_ERRORS[err.type];
  // Express and its body parser mark bad requests themselves, such as a malformed web address.
  if (err.status >= 400 && err.status < 500) return [err.status, 'This request could not be understood'];
  if (err instanceof Prisma.PrismaClientKnownRequestError && PRISMA_ERRORS[err.code]) {
    return PRISMA_ERRORS[err.code];
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return [503, 'Service temporarily unavailable'];
  }
  // PostgreSQL 18 reports blocked RESTRICT deletes as 23001, which Prisma leaves without a P-code.
  if (err instanceof Prisma.PrismaClientUnknownRequestError && err.message.includes('23001')) {
    return PRISMA_ERRORS.P2003;
  }
  // A database CHECK constraint rejected the values.
  if (err instanceof Prisma.PrismaClientUnknownRequestError && err.message.includes('23514')) {
    return [400, 'These values are not allowed'];
  }
  return [500, 'Internal server error'];
};

export const notFound = (req, res) => {
  sendError(res, 404, `Route not found: ${req.method} ${req.originalUrl}`);
};

// Express identifies error handlers by their four arguments, so next must stay.
export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const [status, message, errors] = toClientError(err);
  if (status >= 500) console.error(err);
  sendError(res, status, message, errors);
};
