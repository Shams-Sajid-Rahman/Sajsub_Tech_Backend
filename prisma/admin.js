import bcrypt from 'bcryptjs';

const MIN_PASSWORD_LENGTH = 12;
const BCRYPT_ROUNDS = 12;

// Creates the admin from ADMIN_* environment variables. An existing admin is left
// unchanged, so re-running never resets a password that was changed later.
export const createAdmin = async (prisma) => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in backend/.env');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'ADMIN') {
      throw new Error(`${email} already belongs to a customer account`);
    }
    return { email, created: false };
  }

  await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      firstName: process.env.ADMIN_FIRST_NAME || 'Site',
      lastName: process.env.ADMIN_LAST_NAME || 'Admin',
      role: 'ADMIN',
      emailVerified: true,
    },
  });
  return { email, created: true };
};
