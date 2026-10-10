import 'dotenv/config';
import pg from 'pg';
import { createRecoveryRunner, createOperationRecoveryStore,
  createFixedOperationPricingPolicy, createTokenPricingPolicy } from '@yuva/billing-core';
import { createUsageStore } from '../starter-app/server/stores/usageStore.js';
import { persistRecoveredChatResult } from '../starter-app/server/domain/chatResultPersistence.js';
import { createChatRecoverySettlementStore, listChatProjectionReviews } from '../starter-app/server/domain/chatRecovery.js';

const args = process.argv.slice(2);
const options = { dryRun: true };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') options.dryRun = false;
  else if (args[i] === '--review') options.review = true;
  else if (args[i] === '--dry-run') options.dryRun = true;
  else if (args[i] === '--operation') {
    options.operationId = args[++i];
    if (!/^[0-9a-f-]{36}$/iu.test(options.operationId || '')) throw new Error('Invalid operation UUID');
  } else if (args[i] === '--limit') {
    options.limit = Number(args[++i]);
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('Limit must be 1..100');
  } else throw new Error(`Unsupported argument: ${args[i]}`);
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const policies = [createFixedOperationPricingPolicy({ credits: 0 }), createTokenPricingPolicy({
  inputRate: { credits: 0, tokens: 1 }, outputRate: { credits: 0, tokens: 1 } })];
try {
  const runner = createRecoveryRunner({ recoveryStore: createOperationRecoveryStore({ db }),
    settlementStore: createChatRecoverySettlementStore({ db }), usageStore: createUsageStore({ db }),
    persistResult: persistRecoveredChatResult,
    resolvePolicy: (id, version) => policies.find((policy) => policy.id === id && policy.version === version) });
  const result = await runner.run(options);
  result.projectionReviews = await listChatProjectionReviews({ db, operationId: options.operationId, limit: options.limit ?? 20 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: /^[a-z_]{1,80}$/u.test(error.code || '') ? error.code : 'recovery_failed' }) + '\n');
  process.exitCode = 1;
} finally { await db.end(); }
