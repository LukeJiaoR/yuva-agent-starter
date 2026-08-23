import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beginAdminAction, finishAdminAction } from '../../packages/admin-core/index.js';
import { provisionExternalIdentity } from '../../packages/auth-core/index.js';
import { createServer } from '../server/index.js';

const { Pool } = pg;
const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, '../..');
const baseDatabaseUrl = process.env.TEST_DATABASE_URL
  || 'postgresql://ziwei:changeme_in_production@localhost:45432/ziwei';

describe('out-of-box HTTP and database contract', () => {
  const schema = `test_starter_http_${Date.now()}`;
  let adminPool;
  let db;
  let server;
  let baseUrl;
  let available = false;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: baseDatabaseUrl, connectionTimeoutMillis: 5000 });
    try {
      await adminPool.query('SELECT 1');
      available = true;
    } catch (error) {
      if (process.env.TEST_DATABASE_URL) throw error;
      return;
    }

    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = `${baseDatabaseUrl}${baseDatabaseUrl.includes('?') ? '&' : '?'}options=-csearch_path%3D${schema}`;
    const setup = spawnSync(process.execPath, ['scripts/database.mjs', 'setup'], {
      cwd: rootDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
      },
    });
    if (setup.status !== 0) throw new Error(`Database setup failed: ${setup.stdout}${setup.stderr}`);

    db = new Pool({ connectionString: databaseUrl });
    const app = createServer({
      db,
      callAIStream: async ({ onText }) => {
        await onText('RAW_UNVALIDATED_CHUNK');
        return { finishReason: 'stop', billableTokens: 4 };
      },
      validateOutput: async ({ text }) => ({
        valid: true,
        visibleText: text.replace('RAW_UNVALIDATED', 'VALIDATED_SAFE'),
      }),
      config: {
        env: {
          NODE_ENV: 'development',
          ALLOW_DEV_GUEST: 'true',
          CORS_ORIGIN: 'http://localhost:5173',
          AUTH_TOKEN_SECRET: 'test_auth_secret_that_is_long_enough_for_contracts',
        },
      },
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, 20_000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.end();
    if (available) await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('reports liveness and database readiness through real Express middleware', async (ctx) => {
    if (!available) return ctx.skip();
    const health = await fetch(`${baseUrl}/health`);
    const ready = await fetch(`${baseUrl}/ready`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok' });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: 'ready', database: 'connected' });
    expect(health.headers.get('x-powered-by')).toBeNull();
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('allows both standard Vite development origins', async (ctx) => {
    if (!available) return ctx.skip();
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const response = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('sanitizes malformed JSON errors instead of exposing parser details', async (ctx) => {
    if (!available) return ctx.skip();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const body = await response.json();
    log.mockRestore();
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_json', message: 'The request body must be valid JSON.' });
    expect(JSON.stringify(body)).not.toContain('position');
  });

  it('runs analyze and commits only validated output to the SSE stream', async (ctx) => {
    if (!available) return ctx.skip();
    const analysis = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { subject: 'Renewal', parameters: { plan: 'team' } } }),
    });
    expect(analysis.status).toBe(200);
    await expect(analysis.json()).resolves.toMatchObject({ success: true, facts: { subject: 'Renewal' } });

    const chat = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What comes first?', requestId: 'http-contract-1' }),
    });
    const stream = await chat.text();
    expect(chat.status).toBe(200);
    expect(stream).toContain('VALIDATED_SAFE_CHUNK');
    expect(stream).not.toContain('RAW_UNVALIDATED_CHUNK');
    expect(stream).toContain('event: done');
  });

  it('provides schema parity for external identity provisioning and admin audit', async (ctx) => {
    if (!available) return ctx.skip();
    const user = await provisionExternalIdentity({
      db,
      provider: 'clerk',
      externalId: 'user_http_contract',
      email: 'http-contract@example.com',
      displayName: 'HTTP Contract',
    });
    expect(user.external_auth_id).toBe('user_http_contract');

    const started = await beginAdminAction({
      db,
      actor: { id: 'admin-contract', email: 'admin-contract@example.com', role: 'support' },
      action: 'grant_credits',
      targetType: 'user',
      targetId: user.id,
      reason: 'HTTP contract validation',
      idempotencyKey: 'admin-http-contract',
      payload: { amount: 5 },
      environment: 'test',
    });
    const finished = await finishAdminAction({
      db,
      requestId: started.requestId,
      status: 'succeeded',
      resultSummary: { outcome: 'granted', creditAmount: 5 },
    });
    expect(finished).toMatchObject({ status: 'succeeded', replayed: false });
  });
});
