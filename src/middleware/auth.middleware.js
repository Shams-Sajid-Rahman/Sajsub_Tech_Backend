import { findActiveSession } from '../services/session.service.js';
import { ApiError } from '../utils/ApiError.js';
import { ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../utils/tokens.js';

// The session is checked on every request, so logout, suspension and role changes apply at once.
export const authenticate = async (req, res, next) => {
  const token = req.cookies?.[ACCESS_COOKIE];
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

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) throw new ApiError(403, 'You do not have permission to do this');
  next();
};

export const requireAdmin = [authenticate, requireRole('ADMIN')];
