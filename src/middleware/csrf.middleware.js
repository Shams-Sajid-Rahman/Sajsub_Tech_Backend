import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { CSRF_COOKIE, setCsrfCookie } from '../utils/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const sign = (value) => createHmac('sha256', env.csrfSecret).update(value).digest('base64url');

const safeEqual = (a, b) => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
};

const isSignedToken = (token) => {
  const [value, signature] = token.split('.');
  return Boolean(value && signature) && safeEqual(signature, sign(value));
};

export const issueCsrfToken = (res) => {
  const value = randomBytes(32).toString('base64url');
  const token = `${value}.${sign(value)}`;
  setCsrfCookie(res, token);
  return token;
};

// Signed double-submit: other sites can't read the cookie to copy it into the header.
export const requireCsrf = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(cookie, header) || !isSignedToken(cookie)) {
    throw new ApiError(403, 'Invalid or missing CSRF token');
  }
  next();
};
