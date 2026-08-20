import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  grantCredits,
  reserveFeatureCredits,
  settleFeatureCredits,
  releaseFeatureCredits,
  getCreditBalance,
} from '../../packages/billing-core/index.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Real PostgreSQL Billing & Auth Schema Integration Contract Test', () => {
  const connectionString = process.env.TEST_DATABASE_URL || 'postgresql://ziwei:changeme_in_production@localhost:45432/ziwei';
  let pool = null;
  let client = null;
  let isPostgresAvailable = false;
  const TEST_SCHEMA = `test_starter_${Date.now()}`;
  const USER_ID = '99999999-9999-4999-8999-999999999999';

  beforeAll(async () => {
    try {
      pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
      client = await pool.connect();
      await client.query('SELECT 1');
      isPostgresAvailable = true;

      // 1. Create isolated test schema and set session search path
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // 2. Apply scripts/schema.sql directly to real PostgreSQL
      const schemaSqlPath = path.resolve(__dirname, '../../scripts/schema.sql');
      const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
      await client.query(schemaSql);
    } catch (err) {
      console.warn(`[Real PostgreSQL Test] Skipping live DB tests (Postgres unavailable: ${err.message})`);
      isPostgresAvailable = false;
    }
  });

  afterAll(async () => {
    if (client && isPostgresAvailable) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } catch {}
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('runs complete two-phase ledger lifecycle against real PostgreSQL schema with zero SQL errors', async (ctx) => {
    if (!isPostgresAvailable || !client) {
      ctx.skip();
      return;
    }

    // 1. Insert user with exact auth-core columns
    const userRes = await client.query(
      `INSERT INTO users (id, email, display_name, external_auth_provider, external_auth_id, memory_enabled)
       VALUES ($1, 'test-contract@example.com', 'Contract User', 'clerk', 'user_clerk_real_123', true)
       RETURNING *`,
      [USER_ID],
    );
    expect(userRes.rows[0].email).toBe('test-contract@example.com');
    expect(userRes.rows[0].external_auth_provider).toBe('clerk');

    // 2. Grant 20 purchased credits
    const grantRes = await grantCredits({
      db: client,
      userId: USER_ID,
      credits: 20,
      creditType: 'purchased',
      sourceType: 'test_purchase',
      idempotencyKey: `grant-init-${Date.now()}`,
      reason: 'Starter contract test initial credits',
    });
    expect(grantRes.balance.available).toBe(20);

    // 3. Check normalized credit balance
    const balanceBefore = await getCreditBalance({ db: client, userId: USER_ID });
    expect(balanceBefore.available).toBe(20);
    expect(balanceBefore.reserved).toBe(0);

    // 4. Reserve 2 credits for feature
    const reserveRes = await reserveFeatureCredits({
      db: client,
      userId: USER_ID,
      featureKey: 'deep_reasoning',
      clientRequestId: 'req-real-db-1',
      credits: 2,
    });
    expect(reserveRes.kind).toBe('reserved');
    expect(reserveRes.request.status).toBe('generating');
    expect(reserveRes.balance.available).toBe(18);
    expect(reserveRes.balance.reserved).toBe(2);

    // Assert credit_transactions ledger wrote reserve row without column errors
    const reserveTx = await client.query(
      'SELECT * FROM credit_transactions WHERE user_id = $1 AND transaction_type = \'usage_reserve\'',
      [USER_ID],
    );
    expect(reserveTx.rows.length).toBe(1);
    expect(reserveTx.rows[0].available_delta).toBe(-2);
    expect(reserveTx.rows[0].reserved_delta).toBe(2);
    expect(reserveTx.rows[0].status).toBe('posted');

    // 5. Settle reservation with persistResult
    const settleRes = await settleFeatureCredits({
      db: client,
      userId: USER_ID,
      requestId: reserveRes.request.id,
      creditsUsed: 2,
      persistResult: async (txClient, req) => {
        await txClient.query(
          `UPDATE credit_usage_requests
              SET assistant_text = $2, billable_tokens = $3, settled_at = NOW()
            WHERE id = $1`,
          [req.id, 'Real PostgreSQL verified completion text', 84],
        );
        return { id: req.id };
      },
    });
    expect(settleRes.replay).toBe(false);
    expect(settleRes.request.status).toBe('settled');
    expect(settleRes.balance.available).toBe(18);
    expect(settleRes.balance.reserved).toBe(0);

    // Assert usage request contains persisted assistant text
    const settledUsage = await client.query(
      'SELECT * FROM credit_usage_requests WHERE id = $1',
      [reserveRes.request.id],
    );
    expect(settledUsage.rows[0].assistant_text).toBe('Real PostgreSQL verified completion text');
    expect(settledUsage.rows[0].billable_tokens).toBe(84);
    expect(settledUsage.rows[0].status).toBe('settled');

    // 6. Test Replay on duplicate reservation attempt
    const replayRes = await reserveFeatureCredits({
      db: client,
      userId: USER_ID,
      featureKey: 'deep_reasoning',
      clientRequestId: 'req-real-db-1',
      credits: 2,
    });
    expect(replayRes.kind).toBe('existing');
    expect(replayRes.request.status).toBe('settled');

    // 7. Test Release on failure
    const reserve2 = await reserveFeatureCredits({
      db: client,
      userId: USER_ID,
      featureKey: 'deep_reasoning',
      clientRequestId: 'req-real-db-2',
      credits: 2,
    });
    expect(reserve2.balance.available).toBe(16);
    expect(reserve2.balance.reserved).toBe(2);

    const releaseRes = await releaseFeatureCredits({
      db: client,
      userId: USER_ID,
      requestId: reserve2.request.id,
      failureClass: 'model_overloaded',
    });
    expect(releaseRes.request.status).toBe('released');
    expect(releaseRes.balance.available).toBe(18);
    expect(releaseRes.balance.reserved).toBe(0);
  });
});
