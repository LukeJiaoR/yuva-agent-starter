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
  const explicitTestDb = process.env.TEST_DATABASE_URL;
  const connectionString = explicitTestDb || 'postgresql://ziwei:changeme_in_production@localhost:45432/ziwei';
  let pool = null;
  let isPostgresAvailable = false;
  const TEST_SCHEMA = `test_starter_${Date.now()}`;
  const USER_ID = '99999999-9999-4999-8999-999999999999';
  const RACE_USER_ID = '88888888-8888-4888-8888-888888888888';

  beforeAll(async () => {
    try {
      pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
      await pool.query('SELECT 1');
      isPostgresAvailable = true;

      // 1. Create isolated test schema
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);

      // 2. Apply scripts/schema.sql inside the test schema
      const schemaSqlPath = path.resolve(__dirname, '../../scripts/schema.sql');
      const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');

      const setupClient = await pool.connect();
      try {
        await setupClient.query(`SET search_path TO ${TEST_SCHEMA}, public`);
        await setupClient.query(schemaSql);
      } finally {
        setupClient.release();
      }
    } catch (err) {
      // If TEST_DATABASE_URL was explicitly provided (e.g. in CI), fail-closed!
      if (explicitTestDb) {
        throw new Error(`[Real PostgreSQL Test] Failed to initialize live DB in CI environment: ${err.message}`);
      }
      console.warn(`[Real PostgreSQL Test] Skipping live DB tests in local dev (Postgres unavailable: ${err.message})`);
      isPostgresAvailable = false;
    }
  });

  afterAll(async () => {
    if (pool && isPostgresAvailable) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } catch {}
      await pool.end();
    }
  });

  it('runs complete two-phase ledger lifecycle using Pool and transaction wrapper with zero SQL errors', async (ctx) => {
    if (!isPostgresAvailable) {
      ctx.skip();
      return;
    }

    const testPool = new Pool({
      connectionString: `${connectionString}${connectionString.includes('?') ? '&' : '?'}options=-csearch_path%3D${TEST_SCHEMA},public`,
    });

    try {
      // 1. Insert user with exact auth-core columns
      const userRes = await testPool.query(
        `INSERT INTO users (id, email, display_name, external_auth_provider, external_auth_id, memory_enabled)
         VALUES ($1, 'test-contract@example.com', 'Contract User', 'clerk', 'user_clerk_real_123', true)
         RETURNING *`,
        [USER_ID],
      );
      expect(userRes.rows[0].email).toBe('test-contract@example.com');
      expect(userRes.rows[0].external_auth_provider).toBe('clerk');

      // 2. Grant 20 purchased credits via Pool (validates withCreditTransaction BEGIN/COMMIT)
      const grantRes = await grantCredits({
        db: testPool,
        userId: USER_ID,
        credits: 20,
        creditType: 'purchased',
        sourceType: 'test_purchase',
        idempotencyKey: `grant-init-${Date.now()}`,
        reason: 'Starter contract test initial credits',
      });
      expect(grantRes.balance.available).toBe(20);

      // 3. Check normalized credit balance
      const balanceBefore = await getCreditBalance({ db: testPool, userId: USER_ID });
      expect(balanceBefore.available).toBe(20);
      expect(balanceBefore.reserved).toBe(0);

      // 4. Reserve 2 credits for feature
      const reserveRes = await reserveFeatureCredits({
        db: testPool,
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
      const reserveTx = await testPool.query(
        'SELECT * FROM credit_transactions WHERE user_id = $1 AND transaction_type = \'usage_reserve\'',
        [USER_ID],
      );
      expect(reserveTx.rows.length).toBe(1);
      expect(reserveTx.rows[0].available_delta).toBe(-2);
      expect(reserveTx.rows[0].reserved_delta).toBe(2);
      expect(reserveTx.rows[0].status).toBe('posted');

      // 5. Settle reservation with persistResult
      const settleRes = await settleFeatureCredits({
        db: testPool,
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
      const settledUsage = await testPool.query(
        'SELECT * FROM credit_usage_requests WHERE id = $1',
        [reserveRes.request.id],
      );
      expect(settledUsage.rows[0].assistant_text).toBe('Real PostgreSQL verified completion text');
      expect(settledUsage.rows[0].billable_tokens).toBe(84);
      expect(settledUsage.rows[0].status).toBe('settled');

      // 6. Test Replay on duplicate reservation attempt
      const replayRes = await reserveFeatureCredits({
        db: testPool,
        userId: USER_ID,
        featureKey: 'deep_reasoning',
        clientRequestId: 'req-real-db-1',
        credits: 2,
      });
      expect(replayRes.kind).toBe('existing');
      expect(replayRes.request.status).toBe('settled');

      // 7. Test Release on failure
      const reserve2 = await reserveFeatureCredits({
        db: testPool,
        userId: USER_ID,
        featureKey: 'deep_reasoning',
        clientRequestId: 'req-real-db-2',
        credits: 2,
      });
      expect(reserve2.balance.available).toBe(16);
      expect(reserve2.balance.reserved).toBe(2);

      const releaseRes = await releaseFeatureCredits({
        db: testPool,
        userId: USER_ID,
        requestId: reserve2.request.id,
        failureClass: 'model_overloaded',
      });
      expect(releaseRes.request.status).toBe('released');
      expect(releaseRes.balance.available).toBe(18);
      expect(releaseRes.balance.reserved).toBe(0);
    } finally {
      await testPool.end();
    }
  });

  it('guarantees atomic transactional concurrency (FOR UPDATE account locking)', async (ctx) => {
    if (!isPostgresAvailable) {
      ctx.skip();
      return;
    }

    const testPool = new Pool({
      connectionString: `${connectionString}${connectionString.includes('?') ? '&' : '?'}options=-csearch_path%3D${TEST_SCHEMA},public`,
      max: 10,
    });

    try {
      // 1. Create race test user
      await testPool.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, 'race-user@example.com', 'Race User')`,
        [RACE_USER_ID],
      );

      // 2. Grant exactly 2 credits
      await grantCredits({
        db: testPool,
        userId: RACE_USER_ID,
        credits: 2,
        creditType: 'purchased',
        idempotencyKey: `grant-race-${Date.now()}`,
      });

      // 3. Fire 2 concurrent 2-credit reservations simultaneously
      const [resA, resB] = await Promise.all([
        reserveFeatureCredits({
          db: testPool,
          userId: RACE_USER_ID,
          featureKey: 'deep_reasoning',
          clientRequestId: 'req-race-A',
          credits: 2,
        }),
        reserveFeatureCredits({
          db: testPool,
          userId: RACE_USER_ID,
          featureKey: 'deep_reasoning',
          clientRequestId: 'req-race-B',
          credits: 2,
        }),
      ]);

      const results = [resA, resB];
      const reservedCount = results.filter((r) => r.kind === 'reserved').length;
      const insufficientCount = results.filter((r) => r.kind === 'insufficient').length;

      // Exactly one must succeed and one must be rejected
      expect(reservedCount).toBe(1);
      expect(insufficientCount).toBe(1);

      // Final balance must be non-negative (available: 0, reserved: 2)
      const finalBalance = await getCreditBalance({ db: testPool, userId: RACE_USER_ID });
      expect(finalBalance.available).toBe(0);
      expect(finalBalance.reserved).toBe(2);
      expect(finalBalance.debt).toBe(0);

      // Ledger must contain exactly 1 usage_reserve transaction for this user
      const txRows = await testPool.query(
        'SELECT * FROM credit_transactions WHERE user_id = $1 AND transaction_type = \'usage_reserve\'',
        [RACE_USER_ID],
      );
      expect(txRows.rows.length).toBe(1);
    } finally {
      await testPool.end();
    }
  });

  it('allows retry on released requests under the same clientRequestId without duplicate row violation', async (ctx) => {
    if (!isPostgresAvailable) {
      ctx.skip();
      return;
    }

    const testPool = new Pool({
      connectionString: `${connectionString}${connectionString.includes('?') ? '&' : '?'}options=-csearch_path%3D${TEST_SCHEMA},public`,
    });

    try {
      const RETRY_USER = '77777777-7777-4777-8777-777777777777';
      const RETRY_REQ_ID = 'req-retry-same-id-1';

      await testPool.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, 'retry-user@example.com', 'Retry User')`,
        [RETRY_USER],
      );

      await grantCredits({
        db: testPool,
        userId: RETRY_USER,
        credits: 10,
        creditType: 'purchased',
        idempotencyKey: `grant-retry-${Date.now()}`,
      });

      // 1. Initial attempt fails and releases credits
      const res1 = await reserveFeatureCredits({
        db: testPool,
        userId: RETRY_USER,
        featureKey: 'deep_reasoning',
        clientRequestId: RETRY_REQ_ID,
        credits: 2,
      });
      expect(res1.kind).toBe('reserved');

      await releaseFeatureCredits({
        db: testPool,
        userId: RETRY_USER,
        requestId: res1.request.id,
        failureClass: 'network_timeout',
      });

      const balanceAfterRelease = await getCreditBalance({ db: testPool, userId: RETRY_USER });
      expect(balanceAfterRelease.available).toBe(10);
      expect(balanceAfterRelease.reserved).toBe(0);

      // 2. Retry with exact same clientRequestId -> Re-activates released request
      const res2 = await reserveFeatureCredits({
        db: testPool,
        userId: RETRY_USER,
        featureKey: 'deep_reasoning',
        clientRequestId: RETRY_REQ_ID,
        credits: 2,
        allowRetryOnReleased: true,
      });

      expect(res2.kind).toBe('reserved');
      expect(res2.request.id).toBe(res1.request.id);
      expect(res2.request.status).toBe('generating');
      expect(res2.balance.available).toBe(8);
      expect(res2.balance.reserved).toBe(2);

      // 3. Settle retry
      const settleRetry = await settleFeatureCredits({
        db: testPool,
        userId: RETRY_USER,
        requestId: res2.request.id,
        creditsUsed: 2,
        persistResult: async (client, req) => {
          await client.query(
            `UPDATE credit_usage_requests SET assistant_text = $2 WHERE id = $1`,
            [req.id, 'Retry succeeded with full text'],
          );
          return { id: req.id };
        },
      });

      expect(settleRetry.request.status).toBe('settled');
      expect(settleRetry.balance.available).toBe(8);
      expect(settleRetry.balance.reserved).toBe(0);
    } finally {
      await testPool.end();
    }
  });
});
