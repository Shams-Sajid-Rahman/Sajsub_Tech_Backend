import { env } from '../config/env.js';
import { ACCESS_TOKEN_MINUTES } from './tokens.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const CSRF_COOKIE = 'csrf_token';
export const AI_GUEST_COOKIE = 'ai_guest';

const AI_GUEST_DAYS = 90;

const baseOptions = {
  secure: env.isProduction || env.cookieSameSite === 'none',
  sameSite: env.cookieSameSite,
  path: '/api',
};

const authOptions = { ...baseOptions, httpOnly: true };

export const setAuthCookies = (res, { accessToken, refreshToken, expiresAt }) => {
  res.cookie(ACCESS_COOKIE, accessToken, { ...authOptions, maxAge: ACCESS_TOKEN_MINUTES * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...authOptions, expires: expiresAt });
};

export const clearAuthCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE, authOptions);
  res.clearCookie(REFRESH_COOKIE, authOptions);
};

export const setGuestCookie = (res, token) => {
  res.cookie(AI_GUEST_COOKIE, token, { ...authOptions, path: '/api/ai', maxAge: AI_GUEST_DAYS * 24 * 60 * 60 * 1000 });
};

export const setCsrfCookie = (res, token) => {
  res.cookie(CSRF_COOKIE, token, baseOptions);
};
