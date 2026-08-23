import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { grantCredits } from '../packages/billing-core/index.js';

const { Pool } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(rootDir, '.env') });
dotenv.config({ path: path.join(rootDir, 'starter-app', '.env'), override: false });

const command = process.argv[2] || 'check';
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('DATABASE_URL is required. Copy starter-app/.env.example to starter-app/.env first.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });

async function migrate() {
  const sql = await fs.readFile(path.join(rootDir, 'scripts', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Database schema is up to date.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seed() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Development seed is disabled in production.');
  }
  const userId = process.env.DEV_GUEST_USER_ID || '00000000-0000-0000-0000-000000000001';
  const credits = Number.parseInt(process.env.DEV_GUEST_CREDITS || '25', 10);
  await pool.query(
    `INSERT INTO users (id, email, display_name, auth_provider, last_login_at)
     VALUES ($1, 'dev-guest@example.local', 'Dev Guest', 'development', NOW())
     ON CONFLICT (id) DO UPDATE
       SET display_name = EXCLUDED.display_name, updated_at = NOW()`,
    [userId],
  );
  const result = await grantCredits({
    db: pool,
    userId,
    creditType: 'purchased',
    sourceType: 'signup_grant',
    credits: Number.isSafeInteger(credits) && credits > 0 ? credits : 25,
    idempotencyKey: `starter:dev-guest:${userId}`,
    metadata: { environment: 'development' },
  });
  console.log(`Development guest is ready with ${result.balance.available} available credits.`);
}

async function check() {
  const result = await pool.query(
    `SELECT
       to_regclass('users') IS NOT NULL AS users,
       to_regclass('credit_usage_requests') IS NOT NULL AS billing,
       to_regclass('admin_audit_logs') IS NOT NULL AS admin,
       to_regprocedure('check_rate_limit(character varying,integer,integer)') IS NOT NULL AS rate_limit`,
  );
  const contract = result.rows[0];
  if (!Object.values(contract).every(Boolean)) {
    throw new Error(`Database contract is incomplete: ${JSON.stringify(contract)}`);
  }
  console.log('Database contract check passed.');
}

try {
  if (command === 'migrate') await migrate();
  else if (command === 'seed') await seed();
  else if (command === 'setup') {
    await migrate();
    await seed();
    await check();
  } else if (command === 'check') await check();
  else throw new Error(`Unknown database command: ${command}`);
} catch (error) {
  console.error(`Database ${command} failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
