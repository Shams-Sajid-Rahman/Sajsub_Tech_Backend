import { issueCsrfToken } from '../middleware/csrf.middleware.js';
import * as authService from '../services/auth.service.js';
import { revokeCurrentSession, rotateSession } from '../services/session.service.js';
import {
  ACCESS_COOKIE,
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  clearAdminAuthCookies,
  clearAuthCookies,
  REFRESH_COOKIE,
  setAdminAuthCookies,
  setAuthCookies,
} from '../utils/cookies.js';
import { sendSuccess } from '../utils/response.js';

const requestContext = (req) => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent')?.slice(0, 500),
});

const FORGOT_PASSWORD_MESSAGE = 'If an account exists for that email, a reset link has been sent.';

export const getCsrfToken = (req, res) => {
  sendSuccess(res, { csrfToken: issueCsrfToken(res) });
};

export const register = async (req, res) => {
  const { user, tokens } = await authService.register(req.validated.body, requestContext(req));
  setAuthCookies(res, tokens);
  sendSuccess(res, user, { status: 201, message: 'Account created' });
};

// The store and the dashboard are separate logins, each with its own cookies.
const STORE = { access: ACCESS_COOKIE, refresh: REFRESH_COOKIE, set: setAuthCookies, clear: clearAuthCookies, portal: 'STORE' };
const ADMIN = { access: ADMIN_ACCESS_COOKIE, refresh: ADMIN_REFRESH_COOKIE, set: setAdminAuthCookies, clear: clearAdminAuthCookies, portal: 'ADMIN' };

const loginTo = (area) => async (req, res) => {
  const { user, tokens } = await authService.login(req.validated.body, area.portal, requestContext(req));
  area.set(res, tokens);
  sendSuccess(res, user, { message: 'Logged in' });
};

const refreshIn = (area) => async (req, res) => {
  try {
    const { user, ...tokens } = await rotateSession(req.cookies[area.refresh]);
    area.set(res, tokens);
    sendSuccess(res, user);
  } catch (error) {
    area.clear(res);
    throw error;
  }
};

const logoutOf = (area) => async (req, res) => {
  await revokeCurrentSession({
    accessToken: req.cookies[area.access],
    refreshToken: req.cookies[area.refresh],
  });
  area.clear(res);
  sendSuccess(res, null, { message: 'Logged out' });
};

const sessionIn = (area) => (req, res) => {
  sendSuccess(res, { user: req.user ?? null, canRefresh: !req.user && Boolean(req.cookies[area.refresh]) });
};

export const customerLogin = loginTo(STORE);
export const adminLogin = loginTo(ADMIN);
export const refresh = refreshIn(STORE);
export const adminRefresh = refreshIn(ADMIN);
export const logout = logoutOf(STORE);
export const adminLogout = logoutOf(ADMIN);
export const getSession = sessionIn(STORE);
export const getAdminSession = sessionIn(ADMIN);

export const getMe = (req, res) => {
  sendSuccess(res, req.user);
};

export const updateMe = async (req, res) => {
  sendSuccess(res, await authService.updateProfile(req.user.id, req.validated.body), {
    message: 'Profile updated',
  });
};

export const changePassword = async (req, res) => {
  await authService.changePassword(req.user.id, req.sessionId, req.validated.body);
  sendSuccess(res, null, { message: 'Password changed' });
};

// Runs in the background, so response time doesn't reveal whether the email exists.
export const forgotPassword = (req, res) => {
  authService.requestPasswordReset(req.validated.body.email).catch((error) => {
    console.error('Password reset request failed:', error.message);
  });
  sendSuccess(res, null, { message: FORGOT_PASSWORD_MESSAGE });
};

export const resetPassword = async (req, res) => {
  await authService.resetPassword(req.validated.body);
  clearAuthCookies(res);
  clearAdminAuthCookies(res);
  sendSuccess(res, null, { message: 'Password reset. Please log in with your new password.' });
};
