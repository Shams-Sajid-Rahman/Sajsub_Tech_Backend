import { env } from '../config/env.js';
import { ACCESS_TOKEN_MINUTES } from './tokens.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const ADMIN_ACCESS_COOKIE = 'admin_access_token';
export const ADMIN_REFRESH_COOKIE = 'admin_refresh_token';
export const CSRF_COOKIE = 'csrf_token';
export const AI_GUEST_COOKIE = 'ai_guest';

const AI_GUEST_DAYS = 90;

const baseOptions = {
  secure: env.isProduction || env.cookieSameSite === 'none',
  sameSite: env.cookieSameSite,
  path: '/api',
};

const authOptions = { ...baseOptions, httpOnly: true };
// The dashboard has its own login, and its cookies are only ever sent to admin routes.
const adminAuthOptions = { ...authOptions, path: '/api/admin' };

export const setAuthCookies = (res, { accessToken, refreshToken, expiresAt }) => {
  res.cookie(ACCESS_COOKIE, accessToken, { ...authOptions, maxAge: ACCESS_TOKEN_MINUTES * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...authOptions, expires: expiresAt });
};

export const clearAuthCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE, authOptions);
  res.clearCookie(REFRESH_COOKIE, authOptions);
};

export const setAdminAuthCookies = (res, { accessToken, refreshToken, expiresAt }) => {
  res.cookie(ADMIN_ACCESS_COOKIE, accessToken, { ...adminAuthOptions, maxAge: ACCESS_TOKEN_MINUTES * 60 * 1000 });
  res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, { ...adminAuthOptions, expires: expiresAt });
};

export const clearAdminAuthCookies = (res) => {
  res.clearCookie(ADMIN_ACCESS_COOKIE, adminAuthOptions);
  res.clearCookie(ADMIN_REFRESH_COOKIE, adminAuthOptions);
};

export const setGuestCookie = (res, token) => {
  res.cookie(AI_GUEST_COOKIE, token, { ...authOptions, path: '/api/ai', maxAge: AI_GUEST_DAYS * 24 * 60 * 60 * 1000 });
};

export const setCsrfCookie = (res, token) => {
  res.cookie(CSRF_COOKIE, token, baseOptions);
};
