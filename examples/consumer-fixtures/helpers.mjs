import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { lockDatabaseMigrations, migrateDatabase } from '../scripts/migrations.mjs';

export const material = 'Synthetic handbook: the demo library opens at 09:00 and closes at 17:00.';
export const input = (extra = {}) => ({ question: 'What are the opening hours?',
  parameters: { material }, requestId: randomUUID(), ...extra });
export const environment = { NODE_ENV: 'test', AI_PROVIDER: 'mock' };

export async function database() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Explicit local TEST_DATABASE_URL required; no skipped database acceptance');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a disposable local PostgreSQL database');
  const admin = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const schema = 'example_acceptance_' + randomUUID().replaceAll('-', '');
  let db;
  const close = async () => { await db?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); };
  try {
    const client = await admin.connect();
    try {
      await client.query('BEGIN'); await lockDatabaseMigrations(client);
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = new pg.Pool({ connectionString: url.toString() });
    await migrateDatabase(db);
    return { db, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

// Test-only opaque credentials. A deployed host must use its own verified identity
// provider and tenant-scoped account projection; never copy this fixture as login.
export function identity(userId) {
  const token = randomUUID();
  return { token, auth: {
    verifyRequest: async req => {
      const header = req.headers.authorization;
      if (!header) return { kind: 'missing', token: null };
      if (header !== `Bearer ${token}`) return { kind: 'invalid', token: null };
      return { kind: 'authenticated', provider: 'fixture', tenantId: 'synthetic-organization', userId: 'synthetic-subject' };
    },
    findUser: async (subject, db, verified) => {
      assert.equal(subject, 'synthetic-subject');
      assert.equal(verified.tenantId, 'synthetic-organization');
      assert.equal(verified.provider, 'fixture');
      return { id: userId };
    },
  } };
}

export async function listen(app, token) {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    send: async (body, authorization = `Bearer ${token}`) => {
      const response = await fetch(`${base}/api/chat/stream`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
export async function finances(db, userId) {
  return Object.fromEntries(await Promise.all(['credit_accounts', 'credit_grants', 'credit_transactions', 'credit_usage_requests']
    .map(async table => [table, (await db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY 1`, [userId])).rows])));
}
export async function operation(db, userId, requestId) {
  return (await db.query('SELECT * FROM ai_operations WHERE account_id=$1 AND client_request_id=$2', [userId, requestId])).rows[0];
}
