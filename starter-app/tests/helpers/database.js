import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { lockDatabaseMigrations, migrateDatabase } from '../../../scripts/migrations.mjs';

/** Shared test prerequisite, before any disposable schema can own the extension. */
export async function prepareTestDatabase(admin) {
  const bootstrap = await admin.connect();
  try {
    await bootstrap.query('BEGIN');
    await lockDatabaseMigrations(bootstrap);
    await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    await bootstrap.query('COMMIT');
  } catch (error) {
    await bootstrap.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { bootstrap.release(); }
}

export async function isolatedDatabase({ migrate = true } = {}) {
  const url = process.env.TEST_DATABASE_URL || 'postgresql://ziwei:changeme_in_production@localhost:45432/ziwei';
  const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  const schema = 'test_operations_' + randomUUID().replaceAll('-', '');
  let db;
  const close = async () => {
    await db?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  try {
    // Keep the shared extension outside disposable schemas. Use the same lock
    // as production migrations; release this transaction before migrating.
    await prepareTestDatabase(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const parsed = new URL(url);
    parsed.searchParams.set('options', `-csearch_path=${schema},public`);
    db = new pg.Pool({ connectionString: parsed.toString(), max: 12 });
    if (migrate) await migrateDatabase(db);
    return { db, close, schema };
  } catch (error) { await close().catch(() => {}); throw error; }
}
export const limitsFixture = () => ({ models: ['fixture'], maxCalls: 3, maxRetries: 1, maxInputTokens: 4000, maxOutputTokens: 2000, deadlineMs: 30000 });
export const quoteFixture = (credits = 2) => ({ contractVersion: 1, policyId: 'fixed', policyVersion: '1', unit: 'credit', reserveCredits: credits, authorizedCredits: credits,
  terms: { credits, rounding: 'ceil_operation' }, limits: limitsFixture(), billingScope: 'successful_calls', missingUsage: 'defer', fulfillmentVersion: '1',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() });
export const operationFixture = (accountId, clientRequestId = randomUUID(), taskType = 'text') => ({ accountId, clientRequestId, featureKey: 'test_operation', taskType,
  mode: taskType === 'text' ? 'stream' : 'async', inputVersion: '1', input: { question: 'hello', assets: [{ id: 'asset-1', version: 'v1' }] } });
