import { z } from 'zod';

// bcrypt only uses the first 72 bytes of a password.
const MAX_PASSWORD_BYTES = 72;

const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(255));

const newPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value) <= MAX_PASSWORD_BYTES, 'Password is too long')
  .refine((value) => /[a-zA-Z]/.test(value) && /\d/.test(value), 'Password must contain a letter and a number');

const nameSchema = z.string().trim().min(1, 'Required').max(100);
const phoneSchema = z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/, 'Enter a valid phone number');

// Strict schemas reject unknown fields, so a request can never set role or status.
export const registerSchema = z.strictObject({
  email: emailSchema,
  password: newPasswordSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  phone: phoneSchema.optional(),
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, 'Required').max(1000),
});

export const forgotPasswordSchema = z.strictObject({ email: emailSchema });

export const resetPasswordSchema = z.strictObject({
  token: z.string().min(1).max(200),
  password: newPasswordSchema,
});

export const updateProfileSchema = z
  .strictObject({
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field');

export const changePasswordSchema = z
  .strictObject({
    currentPassword: z.string().min(1, 'Required').max(1000),
    newPassword: newPasswordSchema,
  })
  .refine(({ currentPassword, newPassword }) => currentPassword !== newPassword, {
    message: 'New password must be different',
    path: ['newPassword'],
  });
