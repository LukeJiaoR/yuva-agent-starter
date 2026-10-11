import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { createSelfHostedAuth } from '../server/auth/selfHosted.js';
import { provisionExternalIdentity } from '@yuva/auth-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server/index.js';
import { readSelfHostedConfig } from '../server/auth/config.js';
import { isolatedDatabase } from './helpers/database.js';
import { migrateDatabase } from '../../scripts/migrations.mjs';

const origin = 'http://localhost:5173';
const password = 'Synthetic-test-password-123!';
const config = { NODE_ENV: 'test', AUTH_MODE: 'self-hosted', BETTER_AUTH_URL: origin, FRONTEND_URL: origin,
  AUTH_TRUSTED_ORIGINS: origin, BETTER_AUTH_SECRET: 'synthetic-fixture-only-tND39ubKALz5LMFgVpPqnR2b', AUTH_MAIL_MODE: 'capture' };
function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/^(?:token|password|accessToken|refreshToken|idToken|credentialVersion)$/iu);
    noSecrets(child);
  }
}
describe('self-hosted startup policy', () => {
  it('rejects missing secret, origins, insecure production, and capture production', () => {
    for (const override of [{ BETTER_AUTH_SECRET: '' }, { AUTH_TRUSTED_ORIGINS: '' }, { AUTH_MAIL_MODE: '' },
      { AUTH_TRUSTED_ORIGINS: '*' }, { FRONTEND_URL: 'https://other.example.test' }, { NODE_ENV: 'production' },
      { NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.test', FRONTEND_URL: 'https://app.example.test', AUTH_TRUSTED_ORIGINS: 'https://app.example.test' }]) {
      expect(() => readSelfHostedConfig({ ...config, ...override })).toThrow();
    }
  });
  it('requires mail transport and rejects mixing self-hosted and custom/unknown modes', () => {
    expect(() => createServer({ db: {}, config: { env: { ...config, AUTH_MAIL_MODE: 'smtp' } } })).toThrow(/SMTP/u);
    expect(() => createServer({ db: {}, config: { env: { ...config, AUTH_MAIL_MODE: 'custom' } } })).toThrow(/adapter/u);
    expect(() => createServer({ db: {}, auth: {}, config: { env: config } })).toThrow(/combined/u);
    expect(() => createServer({ db: {}, config: { env: { AUTH_MODE: 'typo' } } })).toThrow(/AUTH_MODE/u);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('self-hosted PostgreSQL and HTTP contract', () => {
  let fixture, db, app, server, base, service;
  beforeAll(async () => {
    fixture = await isolatedDatabase(); db = fixture.db;
    app = createServer({ db, config: { env: config } }); service = app.locals.selfHostedAuth;
    server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.on('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  beforeEach(async () => { await db.query("DELETE FROM auth_rate_limits; DELETE FROM rate_limits WHERE key LIKE 'starter-auth:%'"); });
  afterAll(async () => { await service?.drainMail(); if (server) await new Promise((resolve) => server.close(resolve)); await fixture?.close(); });
  async function request(path, { cookie, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin, 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!path.endsWith('/dev/mail')) noSecrets(json);
    return { status: response.status, json, text, headers: response.headers, cookie: response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ') };
  }
  const post = (path, body, cookie, headers) => request('/api/auth' + path, { body, cookie, headers });
  async function register({ email = `${randomUUID()}@example.test`, verify = true } = {}) {
    expect((await post('/sign-up/email', { name: 'Synthetic User', email, password, role: 'admin', credits: 999999 })).status).toBe(200);
    await service.drainMail();
    const mail = service.mail.list().filter((message) => message.to === email && message.type === 'verify').at(-1);
    expect(mail).toBeTruthy();
    expect(new URL(mail.url).search).toBe('');
    const token = new URLSearchParams(new URL(mail.url).hash.slice(1)).get('token');
    if (verify) expect((await post('/verify-email', { token })).status).toBe(200);
    return { email, token };
  }
  async function login(email, pass = password) {
    const result = await post('/sign-in/email', { email, password: pass });
    expect(result.status).toBe(200); expect(result.cookie).toBeTruthy(); return result.cookie;
  }
  async function resetLink(email) {
    expect((await post('/request-password-reset', { email })).status).toBe(200); await service.drainMail();
    const mail = service.mail.list().filter((message) => message.to === email && message.type === 'reset').at(-1);
    return new URLSearchParams(new URL(mail.url).hash.slice(1)).get('token');
  }
  it('migrates idempotently without changing legacy users or ledger', async () => {
    const before = (await db.query('SELECT * FROM starter_migrations ORDER BY version')).rows;
    await migrateDatabase(db); expect((await db.query('SELECT * FROM starter_migrations ORDER BY version')).rows).toEqual(before);
    expect(before.at(-1).version).toBe(7);
  });
  it('requires verification, preserves host-only HttpOnly Lax cookies, and provisions one grant under concurrency', async () => {
    const { email, token } = await register({ verify: false });
    expect((await post('/sign-in/email', { email, password })).status).toBe(403);
    expect((await post('/verify-email', { token })).status).toBe(200);
    const signedIn = await post('/sign-in/email', { email, password });
    const header = signedIn.headers.getSetCookie().join(';');
    expect(header).toMatch(/HttpOnly/iu); expect(header).toMatch(/SameSite=Lax/iu); expect(header).not.toMatch(/Domain=/iu);
    expect((await request('/api/pricing', { cookie: signedIn.cookie })).status).toBe(409);
    const profiles = await Promise.all(Array.from({ length: 8 }, () => post('/provision', {}, signedIn.cookie)));
    expect(profiles.every((item) => item.status === 200)).toBe(true);
    const ids = new Set(profiles.map((item) => item.json.profile.id)); expect(ids.size).toBe(1);
    const id = [...ids][0];
    expect((await db.query('SELECT * FROM credit_grants WHERE user_id=$1', [id])).rows).toHaveLength(1);
    expect((await db.query('SELECT available_credits FROM credit_accounts WHERE user_id=$1', [id])).rows[0].available_credits).toBe(25);
    expect((await request('/api/pricing', { cookie: signedIn.cookie })).status).toBe(200);
    const identity = (await request('/api/auth/get-session', { cookie: signedIn.cookie })).json;
    expect(identity.user.id).not.toBe(id); expect(identity.profile.id).toBe(id);
    await expect(provisionExternalIdentity({ db, provider: 'clerk', externalId: 'cannot-claim-self-hosted', email, displayName: 'Wrong account' })).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('SELECT external_auth_provider FROM users WHERE id=$1', [id])).rows[0].external_auth_provider).toBe('starter:self-hosted');
  });
  it('sets production Secure cookies without a Domain and rejects oversized auth bodies', async () => {
    const { email } = await register();
    const secureOrigin = 'https://app.example.test';
    const secure = createSelfHostedAuth({ db, sendMail: async () => {}, env: { ...config, NODE_ENV: 'production',
      BETTER_AUTH_URL: secureOrigin, FRONTEND_URL: secureOrigin, AUTH_TRUSTED_ORIGINS: secureOrigin, AUTH_MAIL_MODE: 'custom' } });
    const listener = express().use('/api/auth', secure.router).listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: secureOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      expect(response.status).toBe(200);
      const cookie = response.headers.getSetCookie().join(';');
      expect(cookie).toMatch(/__Secure-starter-auth/u); expect(cookie).toMatch(/; Secure/iu); expect(cookie).toMatch(/HttpOnly/iu); expect(cookie).not.toMatch(/Domain=/iu);
    } finally { await new Promise((resolve) => listener.close(resolve)); }
    expect((await post('/sign-up/email', { name: 'Too big', email, password, extra: 'a'.repeat(17000) })).status).toBe(413);
  });
  it('never claims a same-email old profile or mutates its balance', async () => {
    const { email } = await register();
    const old = (await db.query("INSERT INTO users(email,display_name,external_auth_provider,external_auth_id) VALUES($1,'Old','clerk','legacy-subject') RETURNING id", [email])).rows[0];
    await db.query('INSERT INTO credit_accounts(user_id,available_credits) VALUES($1,123)', [old.id]);
    const result = await post('/provision', {}, await login(email));
    expect(result.status).toBe(409); expect(result.json.code).toBe('identity_conflict');
    expect((await db.query('SELECT available_credits FROM credit_accounts WHERE user_id=$1', [old.id])).rows[0].available_credits).toBe(123);
    expect((await db.query('SELECT * FROM identity_bindings WHERE user_id=$1', [old.id])).rows).toHaveLength(0);
  });
  it('distinguishes anonymous, invalid cookies/bearer, revoked sessions, and database failure', async () => {
    expect((await request('/api/pricing')).status).toBe(200);
    expect((await request('/api/pricing', { cookie: 'starter-auth.session_token=invalid' })).status).toBe(401);
    expect((await request('/api/pricing', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
    const { email } = await register(); const cookie = await login(email);
    const query = vi.spyOn(db, 'query').mockRejectedValue(new Error('synthetic database fault including private payload'));
    expect((await request('/api/auth/get-session', { cookie })).status).toBe(503); query.mockRestore();
    expect((await post('/sign-out', {}, cookie)).status).toBe(200);
    expect((await request('/api/pricing', { cookie })).status).toBe(401);
  });
  it('enforces Origin across auth and business writes, including missing/null/cross-site origins', async () => {
    const { email } = await register(); const cookie = await login(email); await post('/provision', {}, cookie);
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
      expect((await post('/sign-out', {}, cookie, headers)).status).toBe(403);
      expect((await request('/api/analyze', { cookie, body: { input: {} }, headers })).status).toBe(403);
    }
    expect((await post('/sign-out', {}, cookie)).status).toBe(200);
  });
  it('returns indistinguishable signup/reset status and rejects unknown admin/linking endpoints and URL tokens', async () => {
    const { email } = await register();
    const duplicate = await post('/sign-up/email', { name: 'Other', email, password }); expect(duplicate.json).toEqual({ status: true });
    const unknown = await post('/request-password-reset', { email: 'missing@example.test' });
    expect(unknown.json).toEqual((await post('/request-password-reset', { email })).json);
    for (const path of ['/link-social', '/unlink-account', '/change-email', '/change-password', '/admin/ban-user', '/token']) expect((await post(path, {})).status).toBe(404);
    expect((await request('/api/auth/verify-email?token=private')).status).toBe(400);
  });
  it('resets once, rejects replay and expired tokens, and revokes every old session immediately', async () => {
    const { email } = await register(); const first = await login(email); const second = await login(email);
    const token = await resetLink(email); const newPassword = 'Different-synthetic-password-2';
    expect((await post('/reset-password', { token, newPassword })).status).toBe(200);
    expect((await post('/reset-password', { token, newPassword })).status).toBe(400);
    for (const cookie of [first, second]) expect((await request('/api/auth/get-session', { cookie })).status).toBe(401);
    expect((await post('/sign-in/email', { email, password })).status).toBe(401);
    const newCookie = await login(email, newPassword);
    const expired = await resetLink(email); await db.query('UPDATE auth_verifications SET expires_at=NOW()-INTERVAL \'1 second\'');
    expect((await post('/reset-password', { token: expired, newPassword: password })).status).toBe(400);
    expect((await request('/api/auth/get-session', { cookie: newCookie })).status).toBe(200);
  });
  it('fences an old-password login paused across a completed reset', async () => {
    const { email } = await register(); const token = await resetLink(email);
    const hook = service.auth.options.databaseHooks.session.create;
    const original = hook.before; let resume; let reached;
    const paused = new Promise((resolve) => { reached = resolve; });
    hook.before = async (...args) => { reached(); await new Promise((resolve) => { resume = resolve; }); return original(...args); };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const staleLogin = post('/sign-in/email', { email, password }); await paused;
    expect((await post('/reset-password', { token, newPassword: 'Rotated-synthetic-password-2' })).status).toBe(200);
    resume(); const result = await staleLogin; hook.before = original;
    expect(result.status).toBe(401); expect(result.cookie).toBe('');
    expect(log.mock.calls).toEqual([]); log.mockRestore();
    await login(email, 'Rotated-synthetic-password-2');
  }, 15000);
  it('fences disablement after a successful session hook but before its INSERT', async () => {
    const { email } = await register();
    const userId = (await db.query('SELECT id FROM auth_users WHERE email=$1', [email])).rows[0].id;
    const hook = service.auth.options.databaseHooks.session.create; const original = hook.before;
    let resume, reached; const paused = new Promise((resolve) => { reached = resolve; });
    hook.before = async (...args) => { const result = await original(...args); reached(); await new Promise((resolve) => { resume = resolve; }); return result; };
    const inFlight = post('/sign-in/email', { email, password }); await paused;
    try { await db.query('UPDATE auth_users SET disabled=TRUE WHERE id=$1', [userId]); }
    finally { resume(); }
    const result = await inFlight; hook.before = original;
    expect(result.status).toBe(401); expect((await db.query('SELECT * FROM auth_sessions WHERE user_id=$1', [userId])).rowCount).toBe(0);
  });
  it('revokes only on actual credential change, rolls back revocation with password change, and disables immediately', async () => {
    const { email } = await register(); const cookie = await login(email);
    const id = (await request('/api/auth/get-session', { cookie })).json.user.id;
    await db.query('UPDATE auth_accounts SET password=password,access_token=$2 WHERE user_id=$1', [id, 'synthetic-unused-provider-field']);
    expect((await request('/api/auth/get-session', { cookie })).status).toBe(200);
    const client = await db.connect();
    await client.query('BEGIN'); await client.query("UPDATE auth_accounts SET password='synthetic-rollback' WHERE user_id=$1", [id]);
    expect((await client.query('SELECT * FROM auth_sessions WHERE user_id=$1', [id])).rows).toHaveLength(0);
    await client.query('ROLLBACK'); client.release();
    expect((await request('/api/auth/get-session', { cookie })).status).toBe(200);
    await db.query('UPDATE auth_users SET disabled=TRUE WHERE id=$1', [id]);
    expect((await request('/api/auth/get-session', { cookie })).status).toBe(401);
    expect((await post('/sign-in/email', { email, password })).status).toBe(401);
  });
  it('lists safe session IDs, isolates device revocation, and requires a fresh sign-in', async () => {
    const { email } = await register(); const first = await login(email); const second = await login(email);
    const sessions = (await request('/api/auth/sessions', { cookie: first })).json.sessions;
    expect(sessions).toHaveLength(2); expect(sessions.filter((session) => session.current)).toHaveLength(1);
    const other = await register(); const otherCookie = await login(other.email);
    const otherSession = (await request('/api/auth/get-session', { cookie: otherCookie })).json.session;
    await post('/revoke-session', { sessionId: otherSession.id }, first);
    expect((await request('/api/auth/get-session', { cookie: otherCookie })).status).toBe(200);
    await post('/revoke-other-sessions', {}, first);
    expect((await request('/api/auth/get-session', { cookie: second })).status).toBe(401);
    const current = sessions.find((session) => session.current);
    await db.query("UPDATE auth_sessions SET created_at=NOW()-INTERVAL '6 minutes' WHERE id=$1", [current.id]);
    expect((await post('/revoke-other-sessions', {}, first)).json.code).toBe('session_not_fresh');
  });
  it('limits attempts in PostgreSQL and scopes development mail to the exact local origin', async () => {
    const email = 'rate-limit@example.test';
    await db.query("INSERT INTO rate_limits(key,count,window_start) VALUES($1,10,NOW())", [`starter-auth:/request-password-reset:${(await import('node:crypto')).createHash('sha256').update(email).digest('hex')}`]);
    const limited = await post('/request-password-reset', { email }); expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect((await request('/api/auth/dev/mail')).status).toBe(404);
    const headers = { host: 'localhost:5173', 'x-starter-dev-inbox': '1', 'sec-fetch-site': 'same-origin' };
    const localInbox = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/auth/dev/mail', { headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
    });
    expect(localInbox).toBe(200);
    expect((await request('/api/auth/dev/mail', { headers: { ...headers, 'x-forwarded-host': 'tunnel.example' } })).status).toBe(404);
    expect((await request('/api/auth/dev/mail', { headers: { ...headers, host: 'tunnel.example' } })).status).toBe(404);
  });
  it('rejects disabled or replica-only credential guards and accepts origin/always guards', async () => {
    expect((await request('/ready')).status).toBe(200);
    for (const [table, trigger] of [
      ['auth_sessions', 'auth_session_credential'], ['auth_accounts', 'auth_password_revoke'], ['auth_users', 'auth_disabled_revoke'],
    ]) {
      try {
        for (const mode of ['DISABLE', 'ENABLE REPLICA']) {
          await db.query(`ALTER TABLE ${table} ${mode} TRIGGER ${trigger}`);
          const ready = await request('/ready'); expect(ready.status).toBe(503); expect(ready.json.authentication).toBe('schema_unavailable');
        }
        await db.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`);
        expect((await request('/ready')).status).toBe(200);
      } finally { await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
      expect((await request('/ready')).status).toBe(200);
    }
  });
  it('requires origin replication mode on the probed database connection', async () => {
    const client = await db.connect();
    const scoped = createSelfHostedAuth({ db: client, env: config });
    try {
      for (const mode of ['replica', 'local']) {
        await client.query(`SET session_replication_role='${mode}'`);
        expect(await scoped.readiness()).toBe('schema_unavailable');
      }
      await client.query("SET session_replication_role='origin'");
      expect(await scoped.readiness()).toBe('ready');
    } finally { await client.query("SET session_replication_role='origin'"); client.release(); }
  });
  it('maps upstream create-user database errors to 503 without exposing storage detail', async () => {
    await db.query(`CREATE FUNCTION fail_auth_insert() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'synthetic private storage failure' USING ERRCODE='08006'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_auth_user BEFORE INSERT ON auth_users FOR EACH ROW EXECUTE FUNCTION fail_auth_insert()`);
    try {
      const result = await post('/sign-up/email', { name: 'Write failure', email: 'write-failure@example.test', password });
      expect(result.status).toBe(503); expect(result.text).not.toContain('private');
    } finally { await db.query('DROP TRIGGER fail_auth_user ON auth_users; DROP FUNCTION fail_auth_insert()'); }
  });
  it('reports asynchronous mail delivery failure through readiness without logging its payload', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.spyOn(service.mail, 'send').mockRejectedValue(new Error('private-token-and-address'));
    const result = await post('/sign-up/email', { name: 'Mail failure', email: 'mail-failure@example.test', password });
    expect(result.status).toBe(200); await service.drainMail();
    expect(service.mailHealthy()).toBe(false);
    expect((await request('/ready')).status).toBe(503);
    expect(log.mock.calls.flat().join(' ')).not.toContain('private-token');
    send.mockRestore(); log.mockRestore();
    await post('/send-verification-email', { email: 'mail-failure@example.test' }); await service.drainMail();
    expect(service.mailHealthy()).toBe(true);
  });

});
