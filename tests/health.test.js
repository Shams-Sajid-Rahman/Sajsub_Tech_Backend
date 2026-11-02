import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';

after(() => prisma.$disconnect());

test('GET /api/health reports the API is up', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.status, 'ok');
});

test('GET /api/health/db confirms database connectivity', async () => {
  const res = await request(app).get('/api/health/db');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.database, 'connected');
});

test('unknown routes return a JSON 404', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Route not found/);
});
