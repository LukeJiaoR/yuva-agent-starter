// Copied into a separately installed consumer by artifacts.test.js. Every import
// resolves from that consumer; no workspace symlink/source fallback is allowed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createServer } from './server/index.js';
import { migrateDatabase } from './scripts/migrations.mjs';
const url = process.env.TEST_DATABASE_URL;
assert.ok(url, 'Independent self-hosted verification requires TEST_DATABASE_URL');
const admin = new pg.Pool({ connectionString: url });
const schema = 'auth_consumer_' + randomUUID().replaceAll('-', '');
let db, server;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection = new URL(url); connection.searchParams.set('options', `-csearch_path=${schema},public`);
  db = new pg.Pool({ connectionString: connection.toString(), max: 8 });
  await migrateDatabase(db);
  const origin = 'http://localhost:5173';
  const app = createServer({ db, config: { env: { NODE_ENV: 'test', AUTH_MODE: 'self-hosted', BETTER_AUTH_URL: origin,
    FRONTEND_URL: origin, AUTH_TRUSTED_ORIGINS: origin, AUTH_MAIL_MODE: 'capture', ALLOW_DEV_GUEST: 'false',
    BETTER_AUTH_SECRET: 'synthetic-consumer-only-CaK74DWgbXR9hxMvPEr8' } } });
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function post(path, body) {
    const response = await fetch(base + '/api/auth' + path, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${path} must succeed in independently installed consumer`);
    const cookies = response.headers.getSetCookie(); if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    const result = await response.json(); assert.ok(!JSON.stringify(result).match(/"(?:token|password|credentialVersion)"/u));
    return result;
  }
  const email = 'synthetic-consumer@example.test'; const password = 'Synthetic-consumer-password-1';
  await post('/sign-up/email', { name: 'Consumer', email, password }); await app.locals.selfHostedAuth.drainMail();
  const message = app.locals.selfHostedAuth.mail.list().at(-1); assert.ok(message);
  const token = new URLSearchParams(new URL(message.url).hash.slice(1)).get('token');
  await post('/verify-email', { token }); await post('/sign-in/email', { email, password });
  const profiles = await Promise.all(Array.from({ length: 4 }, () => post('/provision', {})));
  assert.equal(new Set(profiles.map((result) => result.profile.id)).size, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM credit_grants')).rows[0].count, 1);
  assert.equal((await fetch(base + '/api/pricing', { headers: { cookie } })).status, 200);
  const oldCookie = cookie; await post('/sign-out', {});
  assert.equal((await fetch(base + '/api/pricing', { headers: { cookie: oldCookie } })).status, 401);
  console.log('Independent self-hosted consumer: signup, verify, cookie login, idempotent profile/grant, logout passed.');
} finally {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await db?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
}
