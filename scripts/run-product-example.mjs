import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createServer } from '../starter-app/server/index.js';
import { migrateDatabase } from './migrations.mjs';
import { grantCredits } from '@yuva/billing-core';

const strategy = process.argv[2];
if (!['fixed','token'].includes(strategy)) throw new Error('Choose fixed or token');
if (process.env.NODE_ENV === 'production') throw new Error('Examples are development-only');
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('A local TEST_DATABASE_URL is required');
const parsed = new URL(url);
if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)) throw new Error('Examples require a local database');
const schema = `example_${strategy}_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: url });
let db, server;
async function close() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  parsed.searchParams.set('options', `-csearch_path=${schema},public`);
  db = new pg.Pool({ connectionString: parsed.toString() });
  await migrateDatabase(db);
  const userId = '00000000-0000-0000-0000-000000000001';
  await db.query('INSERT INTO users(id) VALUES($1)', [userId]);
  await grantCredits({ db, userId, credits: 1000, creditType: 'purchased', idempotencyKey: randomUUID() });
  const app = createServer({ db, config: { env: { NODE_ENV: 'development', ALLOW_DEV_GUEST: 'true', AI_PROVIDER: 'mock', PRICING_STRATEGY: strategy } },
    // Deterministic adapter fixture, explicitly synthetic. Token demo opts into frozen ceiling estimates below.
    callAIStream: async ({ onText }) => { await onText(`${strategy} example: your request has a recoverable result.`);
      return { usage: { source: 'synthetic', inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 } }; },
    ...(strategy === 'token' ? { config: { env: { NODE_ENV: 'development', ALLOW_DEV_GUEST: 'true', AI_PROVIDER: 'mock' },
      pricing: { strategy: 'token', featureKey: 'token_example', inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 },
        allowEstimates: true, limits: { maxInputTokens: 4000, maxOutputTokens: 1000 } } } } : {}),
  });
  server = app.listen(3000, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  console.log(`${strategy} example API: http://localhost:3000 (isolated temporary schema; synthetic fixture)`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { close().then(() => process.exit(0)); });
} catch (error) { await close(); throw error; }
