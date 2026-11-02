import { issueCsrfToken } from '../middleware/csrf.middleware.js';
import * as authService from '../services/auth.service.js';
import { revokeCurrentSession, rotateSession } from '../services/session.service.js';
import { ACCESS_COOKIE, clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from '../utils/cookies.js';
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

const loginTo = (portal) => async (req, res) => {
  const { user, tokens } = await authService.login(req.validated.body, portal, requestContext(req));
  setAuthCookies(res, tokens);
  sendSuccess(res, user, { message: 'Logged in' });
};

export const customerLogin = loginTo('CUSTOMER');
export const adminLogin = loginTo('ADMIN');

export const refresh = async (req, res) => {
  try {
    const { user, ...tokens } = await rotateSession(req.cookies[REFRESH_COOKIE]);
    setAuthCookies(res, tokens);
    sendSuccess(res, user);
  } catch (error) {
    clearAuthCookies(res);
    throw error;
  }
};

export const logout = async (req, res) => {
  await revokeCurrentSession({
    accessToken: req.cookies[ACCESS_COOKIE],
    refreshToken: req.cookies[REFRESH_COOKIE],
  });
  clearAuthCookies(res);
  sendSuccess(res, null, { message: 'Logged out' });
};

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
  sendSuccess(res, null, { message: 'Password reset. Please log in with your new password.' });
};
