import 'dotenv/config';
import { z } from 'zod';

const optionalText = z.preprocess((value) => value || undefined, z.string().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    CLIENT_URL: z.url().default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    JWT_SECRET: z.string().min(32),
    CSRF_SECRET: z.string().min(32),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    SMTP_HOST: optionalText,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_USER: optionalText,
    SMTP_PASS: optionalText,
    EMAIL_FROM: optionalText,
  })
  .refine(({ JWT_SECRET, CSRF_SECRET }) => JWT_SECRET !== CSRF_SECRET, {
    path: ['CSRF_SECRET'],
    message: 'Must differ from JWT_SECRET',
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Only variable names are printed, never their values.
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
  console.error(`Invalid environment variables: ${names.join(', ')}. See backend/.env.example.`);
  process.exit(1);
}

const { data } = parsed;

export const env = {
  nodeEnv: data.NODE_ENV,
  isProduction: data.NODE_ENV === 'production',
  port: data.PORT,
  clientUrl: data.CLIENT_URL,
  databaseUrl: data.DATABASE_URL,
  trustProxy: data.TRUST_PROXY,
  jwtSecret: data.JWT_SECRET,
  csrfSecret: data.CSRF_SECRET,
  cookieSameSite: data.COOKIE_SAMESITE,
  smtp: { host: data.SMTP_HOST, port: data.SMTP_PORT, user: data.SMTP_USER, pass: data.SMTP_PASS },
  emailFrom: data.EMAIL_FROM,
};
