import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/prisma.js';

const tag = `authtest-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'Correct-horse-1';
const NEW_PASSWORD = 'Battery-staple-2';
const emailFor = (name) => `${tag}-${name}@example.com`;

const adminEmail = emailFor('admin');
await prisma.user.create({
  data: {
    email: adminEmail,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    firstName: 'Test',
    lastName: 'Admin',
    role: 'ADMIN',
  },
});

// A browser-like client: keeps cookies and sends the CSRF header.
const createClient = async () => {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/auth/csrf-token');
  const csrfToken = body.data.csrfToken;
  const send = (method, path, data) => agent[method](path).set('X-CSRF-Token', csrfToken).send(data);
  return {
    agent,
    get: (path) => agent.get(path),
    post: (path, data) => send('post', path, data),
    patch: (path, data) => send('patch', path, data),
  };
};

const registerCustomer = async (name, extra = {}) => {
  const client = await createClient();
  const res = await client.post('/api/auth/register', {
    email: emailFor(name),
    password: PASSWORD,
    firstName: 'Test',
    lastName: 'Customer',
    ...extra,
  });
  return { client, res };
};

// For tests about other features, so they don't use up the registration rate limit.
const createCustomer = async (name) => {
  await prisma.user.create({
    data: {
      email: emailFor(name),
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      firstName: 'Test',
      lastName: 'Customer',
    },
  });
  const client = await createClient();
  const res = await client.post('/api/auth/login', { email: emailFor(name), password: PASSWORD });
  return { client, res };
};

const adminClient = async () => {
  const client = await createClient();
  await client.post('/api/admin/auth/login', { email: adminEmail, password: PASSWORD });
  return client;
};

const cookieHeader = (res, name) => res.headers['set-cookie']?.find((cookie) => cookie.startsWith(`${name}=`));

after(async () => {
  await prisma.loginLog.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

test('registration creates a logged-in CUSTOMER and never returns the hash', async () => {
  const { client, res } = await registerCustomer('new');
  assert.equal(res.status, 201);
  assert.equal(res.body.data.role, 'CUSTOMER');
  assert.doesNotMatch(JSON.stringify(res.body), /passwordHash|\$2[aby]\$/);

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.email, emailFor('new'));
  assert.equal(me.body.data.passwordHash, undefined);

  const stored = await prisma.user.findUnique({ where: { email: emailFor('new') } });
  assert.ok(stored.passwordHash.startsWith('$2'));
});

test('auth cookies are HTTP-only with SameSite set', async () => {
  const { res } = await registerCustomer('cookies');
  for (const name of ['access_token', 'refresh_token']) {
    const cookie = cookieHeader(res, name);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  }
  assert.equal(JSON.stringify(res.body).includes('access_token'), false);
});

test('customers cannot assign themselves a role at registration or in their profile', async () => {
  const { res } = await registerCustomer('role', { role: 'ADMIN' });
  assert.equal(res.status, 400);
  assert.equal(await prisma.user.count({ where: { email: emailFor('role') } }), 0);

  const { client } = await createCustomer('role2');
  const update = await client.patch('/api/auth/me', { role: 'ADMIN' });
  assert.equal(update.status, 400);
  const stored = await prisma.user.findUnique({ where: { email: emailFor('role2') } });
  assert.equal(stored.role, 'CUSTOMER');
});

test('registration validates input and rejects duplicates', async () => {
  const client = await createClient();
  const weak = await client.post('/api/auth/register', {
    email: emailFor('weak'),
    password: 'short',
    firstName: 'A',
    lastName: 'B',
  });
  assert.equal(weak.status, 400);

  const badEmail = await client.post('/api/auth/register', {
    email: 'nope',
    password: PASSWORD,
    firstName: 'A',
    lastName: 'B',
  });
  assert.equal(badEmail.status, 400);

  await registerCustomer('dup');
  const { res } = await registerCustomer('dup');
  assert.equal(res.status, 409);
});

test('login works, emails ignore case, and activity is logged', async () => {
  await createCustomer('login');
  const client = await createClient();
  const res = await client.post('/api/auth/login', { email: emailFor('LOGIN').toUpperCase(), password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal((await client.get('/api/auth/me')).status, 200);

  const logs = await prisma.loginLog.count({ where: { email: emailFor('login').toLowerCase(), success: true } });
  assert.equal(logs, 2);
});

test('invalid credentials get the same response, and the real reason is logged', async () => {
  await createCustomer('wrong');
  const client = await createClient();
  const wrong = await client.post('/api/auth/login', { email: emailFor('wrong'), password: 'Wrong-password-1' });
  const unknown = await client.post('/api/auth/login', { email: emailFor('ghost'), password: PASSWORD });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.message, unknown.body.message);

  const log = await prisma.loginLog.findFirst({ where: { email: emailFor('wrong'), success: false } });
  assert.equal(log.failureReason, 'WRONG_PASSWORD');
});

test('logout revokes the session on the server', async () => {
  const { client, res } = await createCustomer('logout');
  const stolenAccess = cookieHeader(res, 'access_token').split(';')[0];

  assert.equal((await client.post('/api/auth/logout')).status, 200);
  assert.equal((await client.get('/api/auth/me')).status, 401);

  // A copied token must not keep working after logout.
  const replay = await request(app).get('/api/auth/me').set('Cookie', stolenAccess);
  assert.equal(replay.status, 401);
});

test('expired access tokens can be refreshed, and the refresh token rotates', async () => {
  const { client, res } = await createCustomer('refresh');
  const oldRefresh = cookieHeader(res, 'refresh_token').split(';')[0];
  const { sid, sub } = jwt.decode(cookieHeader(res, 'access_token').split(';')[0].split('=')[1]);

  const expired = jwt.sign({ sid }, env.jwtSecret, { subject: sub, issuer: 'sajsub-tech', expiresIn: -10 });
  const rejected = await request(app).get('/api/auth/me').set('Cookie', `access_token=${expired}`);
  assert.equal(rejected.status, 401);

  assert.equal((await client.post('/api/auth/refresh')).status, 200);
  assert.equal((await client.get('/api/auth/me')).status, 200);

  const csrf = await client.get('/api/auth/csrf-token');
  const { csrfToken } = csrf.body.data;
  const reused = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', `${oldRefresh}; csrf_token=${csrfToken}`)
    .set('X-CSRF-Token', csrfToken);
  assert.equal(reused.status, 401);
});

test('expired and suspended sessions are rejected', async () => {
  const expired = await createCustomer('expired');
  await prisma.userSession.updateMany({
    where: { user: { email: emailFor('expired') } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await expired.client.get('/api/auth/me')).status, 401);
  assert.equal((await expired.client.post('/api/auth/refresh')).status, 401);

  const suspended = await createCustomer('suspended');
  await prisma.user.update({ where: { email: emailFor('suspended') }, data: { status: 'SUSPENDED' } });
  assert.equal((await suspended.client.get('/api/auth/me')).status, 401);
  const relogin = await (await createClient()).post('/api/auth/login', {
    email: emailFor('suspended'),
    password: PASSWORD,
  });
  assert.equal(relogin.status, 401);
});

test('forged tokens are rejected', async () => {
  const none = jwt.sign({ sid: randomUUID() }, '', { algorithm: 'none', subject: randomUUID(), issuer: 'sajsub-tech' });
  const wrongKey = jwt.sign({ sid: randomUUID() }, 'x'.repeat(40), { subject: randomUUID(), issuer: 'sajsub-tech' });
  for (const token of [none, wrongKey, 'garbage']) {
    const res = await request(app).get('/api/auth/me').set('Cookie', `access_token=${token}`);
    assert.equal(res.status, 401);
  }
});

test('anonymous requests cannot reach protected APIs', async () => {
  for (const path of ['/api/auth/me', '/api/admin/profile', '/api/admin/anything']) {
    assert.equal((await request(app).get(path)).status, 401, path);
  }
});

test('a customer login opens no admin API', async () => {
  const { client } = await createCustomer('notadmin');
  for (const path of ['/api/admin/profile', '/api/admin/users', '/api/admin/anything']) {
    assert.equal((await client.get(path)).status, 401, path);
  }
  assert.equal((await client.patch('/api/admin/profile', { firstName: 'Hacker' })).status, 401);
});

test('admin login, profile and logout work', async () => {
  const client = await adminClient();
  const profile = await client.get('/api/admin/profile');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.role, 'ADMIN');

  const update = await client.patch('/api/admin/profile', { firstName: 'Renamed' });
  assert.equal(update.body.data.firstName, 'Renamed');

  assert.equal((await client.get('/api/admin/not-built-yet')).status, 404);

  assert.equal((await client.post('/api/admin/auth/logout')).status, 200);
  assert.equal((await client.get('/api/admin/profile')).status, 401);
});

test('customers cannot log in to the dashboard', async () => {
  await createCustomer('portal');
  const client = await createClient();
  const customerAtAdmin = await client.post('/api/admin/auth/login', { email: emailFor('portal'), password: PASSWORD });
  assert.equal(customerAtAdmin.status, 401);
  assert.equal((await client.get('/api/admin/auth/session')).body.data.user, null);
});

test('a customer token placed in the admin cookie is still refused', async () => {
  const client = await createClient();
  const res = await client.post('/api/auth/register', { email: emailFor('forged'), password: PASSWORD, firstName: 'For', lastName: 'Ged' });
  const token = cookieHeader(res, 'access_token').split(';')[0].split('=')[1];
  const forged = await request(app).get('/api/admin/users').set('Cookie', `admin_access_token=${token}`);
  assert.equal(forged.status, 403);
});

test('the dashboard and the store are separate logins', async () => {
  const client = await createClient();
  const adminLogin = await client.post('/api/admin/auth/login', { email: adminEmail, password: PASSWORD });
  assert.equal(adminLogin.status, 200);
  assert.ok(adminLogin.headers['set-cookie'].every((cookie) => cookie.startsWith('admin_') && cookie.includes('Path=/api/admin')));

  // Logging in to the dashboard does not log in to the store.
  assert.equal((await client.get('/api/auth/session')).body.data.user, null);
  assert.equal((await client.get('/api/admin/auth/session')).body.data.user.email, adminEmail);

  // The same account can log in to the store and shop like a customer.
  assert.equal((await client.post('/api/auth/login', { email: adminEmail, password: PASSWORD })).status, 200);
  assert.equal((await client.get('/api/auth/session')).body.data.user.email, adminEmail);
  assert.equal((await client.get('/api/cart')).status, 200);

  // Logging out of one leaves the other logged in.
  assert.equal((await client.post('/api/auth/logout')).status, 200);
  assert.equal((await client.get('/api/auth/session')).body.data.user, null);
  assert.equal((await client.get('/api/admin/profile')).status, 200);
  assert.equal((await client.post('/api/auth/login', { email: adminEmail, password: PASSWORD })).status, 200);
  assert.equal((await client.post('/api/admin/auth/logout')).status, 200);
  assert.equal((await client.get('/api/admin/profile')).status, 401);
  assert.equal((await client.get('/api/auth/session')).body.data.user.email, adminEmail);
});

test('a store login on an admin account never opens the dashboard', async () => {
  const client = await createClient();
  assert.equal((await client.post('/api/auth/login', { email: adminEmail, password: PASSWORD })).status, 200);
  assert.equal((await client.get('/api/admin/users')).status, 401);
  assert.equal((await client.post('/api/admin/auth/refresh')).status, 401);
});

test('the dashboard login refreshes on its own', async () => {
  const client = await createClient();
  await client.post('/api/admin/auth/login', { email: adminEmail, password: PASSWORD });
  const refreshed = await client.post('/api/admin/auth/refresh');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.role, 'ADMIN');
  assert.equal((await client.get('/api/admin/profile')).status, 200);
});

test('no public route can create an admin', async () => {
  const client = await createClient();
  const res = await client.post('/api/admin/auth/register', { email: emailFor('sneaky'), password: PASSWORD });
  assert.equal(res.status, 401);
  assert.equal(await prisma.user.count({ where: { email: emailFor('sneaky') } }), 0);
});

test('requests without a valid CSRF token are refused', async () => {
  const body = { email: emailFor('csrf'), password: PASSWORD };
  const missing = await request(app).post('/api/auth/login').send(body);
  assert.equal(missing.status, 403);

  const forged = await request(app)
    .post('/api/auth/login')
    .set('Cookie', 'csrf_token=abc.def')
    .set('X-CSRF-Token', 'abc.def')
    .send(body);
  assert.equal(forged.status, 403);
});

test('profile updates and password changes work, and other devices are signed out', async () => {
  const { client: laptop } = await createCustomer('change');
  const phone = await createClient();
  await phone.post('/api/auth/login', { email: emailFor('change'), password: PASSWORD });

  const profile = await laptop.patch('/api/auth/me', { firstName: 'Updated', phone: '+1 555 010 9999' });
  assert.equal(profile.body.data.firstName, 'Updated');

  const wrong = await laptop.post('/api/auth/change-password', { currentPassword: 'Nope-12345', newPassword: NEW_PASSWORD });
  assert.equal(wrong.status, 400);

  const ok = await laptop.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal((await laptop.get('/api/auth/me')).status, 200);
  assert.equal((await phone.get('/api/auth/me')).status, 401);

  const fresh = await createClient();
  const relogin = await fresh.post('/api/auth/login', { email: emailFor('change'), password: NEW_PASSWORD });
  assert.equal(relogin.status, 200);
});

test('password reset works once, signs out all sessions, and reveals nothing about emails', async () => {
  const { client: session } = await createCustomer('reset');
  const client = await createClient();

  const unknown = await client.post('/api/auth/forgot-password', { email: emailFor('nobody') });
  assert.equal(unknown.status, 200);

  // The development email service prints the link, so the test reads it from there.
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  let token;
  try {
    const known = await client.post('/api/auth/forgot-password', { email: emailFor('reset') });
    assert.equal(known.body.message, unknown.body.message);
    for (let i = 0; i < 50 && !token; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      token = lines.join('\n').match(/token=([\w-]+)/)?.[1];
    }
  } finally {
    console.log = originalLog;
  }
  assert.ok(token, 'reset link was produced');

  const stored = await prisma.passwordResetToken.findFirst({ where: { user: { email: emailFor('reset') } } });
  assert.notEqual(stored.tokenHash, token);

  const done = await client.post('/api/auth/reset-password', { token, password: NEW_PASSWORD });
  assert.equal(done.status, 200);
  assert.equal((await session.get('/api/auth/me')).status, 401);

  const again = await client.post('/api/auth/reset-password', { token, password: 'Another-pass-3' });
  assert.equal(again.status, 400);

  const login = await client.post('/api/auth/login', { email: emailFor('reset'), password: NEW_PASSWORD });
  assert.equal(login.status, 200);
});

test('expired and invalid reset tokens are rejected', async () => {
  await createCustomer('resetold');
  const user = await prisma.user.findUnique({ where: { email: emailFor('resetold') } });
  const token = `${tag}-expired`;
  const { hashToken } = await import('../src/utils/tokens.js');
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() - 1000) },
  });
  const client = await createClient();
  assert.equal((await client.post('/api/auth/reset-password', { token, password: NEW_PASSWORD })).status, 400);
  assert.equal((await client.post('/api/auth/reset-password', { token: 'made-up', password: NEW_PASSWORD })).status, 400);
});

// Keep last: it uses up this process's login limit.
test('repeated failed logins are rate limited', async () => {
  const client = await createClient();
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = await client.post('/api/auth/login', { email: emailFor('brute'), password: 'Wrong-password-1' });
  }
  assert.equal(last.status, 429);
});
