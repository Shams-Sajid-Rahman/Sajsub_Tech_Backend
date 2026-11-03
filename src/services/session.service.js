import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { generateToken, hashToken, signAccessToken, verifyAccessToken } from '../utils/tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME_MS = { CUSTOMER: 7 * DAY_MS, ADMIN: DAY_MS };

// Everything an API response may show about a user. Never add passwordHash here.
export const SAFE_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  status: true,
  emailVerified: true,
  lastLoginAt: true,
  createdAt: true,
};

const activeSessionWhere = () => ({
  revokedAt: null,
  expiresAt: { gt: new Date() },
  user: { status: 'ACTIVE' },
});

export const createSession = async (user, { ipAddress, userAgent }) => {
  const refreshToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS[user.role]);
  const session = await prisma.userSession.create({
    data: { userId: user.id, refreshTokenHash: hashToken(refreshToken), expiresAt, ipAddress, userAgent },
  });
  return {
    accessToken: signAccessToken({ userId: user.id, sessionId: session.id }),
    refreshToken,
    expiresAt,
  };
};

export const findActiveSession = (sessionId, userId) =>
  prisma.userSession.findFirst({
    where: { ...activeSessionWhere(), id: sessionId, userId },
    select: { id: true, user: { select: SAFE_USER_SELECT } },
  });

// Replaces the refresh token. The original expiry stays, so a session can't be extended forever.
export const rotateSession = async (refreshToken) => {
  const unauthorized = new ApiError(401, 'Session expired. Please log in again.');
  if (!refreshToken) throw unauthorized;

  const refreshTokenHash = hashToken(refreshToken);
  const session = await prisma.userSession.findFirst({
    where: { ...activeSessionWhere(), refreshTokenHash },
    select: { id: true, expiresAt: true, user: { select: SAFE_USER_SELECT } },
  });
  if (!session) throw unauthorized;

  const newToken = generateToken();
  const { count } = await prisma.userSession.updateMany({
    where: { id: session.id, refreshTokenHash },
    data: { refreshTokenHash: hashToken(newToken), lastUsedAt: new Date() },
  });
  if (count === 0) throw unauthorized;

  return {
    user: session.user,
    accessToken: signAccessToken({ userId: session.user.id, sessionId: session.id }),
    refreshToken: newToken,
    expiresAt: session.expiresAt,
  };
};

// Works from either cookie, so logging out still succeeds after the access token has expired.
export const revokeCurrentSession = async ({ accessToken, refreshToken }) => {
  const or = [];
  if (refreshToken) or.push({ refreshTokenHash: hashToken(refreshToken) });
  if (accessToken) {
    try {
      or.push({ id: verifyAccessToken(accessToken, { ignoreExpiration: true }).sid });
    } catch {
      // A forged access token identifies no session.
    }
  }
  if (or.length === 0) return;
  await prisma.userSession.updateMany({
    where: { OR: or, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

// Old login records have no further use, and would otherwise pile up forever.
export const purgeExpiredAuthData = async () => {
  const now = new Date();
  await prisma.userSession.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } });
};

export const revokeUserSessions = (client, userId, exceptSessionId) =>
  client.userSession.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId && { id: { not: exceptSessionId } }) },
    data: { revokedAt: new Date() },
  });
