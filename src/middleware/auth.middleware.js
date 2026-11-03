import { findActiveSession } from '../services/session.service.js';
import { ApiError } from '../utils/ApiError.js';
import { ACCESS_COOKIE, ADMIN_ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../utils/tokens.js';

// The session is checked on every request, so logout, suspension and role changes apply at once.
const authenticateWith = (cookieName) => async (req, res, next) => {
  const token = req.cookies?.[cookieName];
  if (!token) throw new ApiError(401, 'Authentication required');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, 'Authentication required');
  }

  const session = await findActiveSession(payload.sid, payload.sub);
  if (!session) throw new ApiError(401, 'Authentication required');

  req.user = session.user;
  req.sessionId = session.id;
  next();
};

export const authenticate = authenticateWith(ACCESS_COOKIE);

// For routes that work for guests too: a missing or expired login simply means a guest.
const optionalWith = (cookieName) => async (req, res, next) => {
  const token = req.cookies?.[cookieName];
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      const session = await findActiveSession(payload.sid, payload.sub);
      if (session) req.user = session.user;
    } catch {
      // Treated as a guest.
    }
  }
  next();
};

export const optionalAuthenticate = optionalWith(ACCESS_COOKIE);
export const optionalAdminAuthenticate = optionalWith(ADMIN_ACCESS_COOKIE);

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) throw new ApiError(403, 'You do not have permission to do this');
  next();
};

// Only the dashboard's own login opens admin routes. A store login never does, even for an admin account.
export const requireAdmin = [authenticateWith(ADMIN_ACCESS_COOKIE), requireRole('ADMIN')];
