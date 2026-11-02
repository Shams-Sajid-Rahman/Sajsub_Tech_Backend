import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { generateToken, hashToken } from '../utils/tokens.js';
import { sendPasswordResetEmail } from './email.service.js';
import { createSession, revokeUserSessions, SAFE_USER_SELECT } from './session.service.js';

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

// Compared when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync(generateToken(), BCRYPT_ROUNDS);

const toSafeUser = (user) => Object.fromEntries(Object.keys(SAFE_USER_SELECT).map((key) => [key, user[key]]));

const logLogin = ({ userId, email, success, failureReason }, { ipAddress, userAgent }) =>
  prisma.loginLog.create({ data: { userId, email, success, failureReason, ipAddress, userAgent } });

const findLoginFailure = (user, passwordMatches, portal) => {
  if (!user) return 'UNKNOWN_EMAIL';
  if (!passwordMatches) return 'WRONG_PASSWORD';
  if (user.status !== 'ACTIVE') return 'ACCOUNT_INACTIVE';
  if (user.role !== portal) return 'WRONG_LOGIN_PORTAL';
  return null;
};

// Admins and customers each log in through their own endpoint. Every failure returns
// the same message, and the real reason only goes to the login log.
export const login = async ({ email, password }, portal, context) => {
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  const failureReason = findLoginFailure(user, passwordMatches, portal);

  await logLogin({ userId: user?.id, email, success: !failureReason, failureReason }, context);
  if (failureReason) throw new ApiError(401, 'Invalid email or password');

  const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { user: toSafeUser(updated), tokens: await createSession(updated, context) };
};

// Public registration has no role input: the column default makes every account a CUSTOMER.
export const register = async (input, context) => {
  const { password, ...profile } = input;
  const user = await prisma.user.create({
    data: {
      ...profile,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      lastLoginAt: new Date(),
    },
  });
  await logLogin({ userId: user.id, email: user.email, success: true }, context);
  return { user: toSafeUser(user), tokens: await createSession(user, context) };
};

export const updateProfile = (userId, data) =>
  prisma.user.update({ where: { id: userId }, data, select: SAFE_USER_SELECT });

// Signs out every other device, in case the old password was compromised.
export const changePassword = async (userId, sessionId, { currentPassword, newPassword }) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new ApiError(400, 'Current password is incorrect');
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    revokeUserSessions(prisma, userId, sessionId),
  ]);
};

export const requestPasswordReset = async (email) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== 'ACTIVE') return;

  const token = generateToken();
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_LIFETIME_MS),
      },
    }),
  ]);
  await sendPasswordResetEmail(user.email, `${env.clientUrl}/reset-password?token=${token}`);
};

export const resetPassword = async ({ token, password }) => {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const invalid = new ApiError(400, 'This reset link is invalid or has expired');

  await prisma.$transaction(async (tx) => {
    const reset = await tx.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!reset) throw invalid;

    // Conditional update, so two simultaneous requests can't both use one token.
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw invalid;

    await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
    await revokeUserSessions(tx, reset.userId);
  });
};
