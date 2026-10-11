import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { grantCredits, getCreditBalance, operationFromRow } from '@yuva/billing-core';
import { createBudgetedProvider, createMeteredProvider } from '@yuva/ai-engine';
import { createExampleServer } from '../starter-app/server/product.js';
import { INPUT_VERSION, PRICING, LIMITS } from '../starter-app/server/domain/contract.js';
import { createUsageStore } from '../starter-app/server/stores/usageStore.js';
import { verifyBundle, digest } from '../scripts/release/artifacts.mjs';
import { database, identity, listen, input, finances, operation, environment } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { profile } = JSON.parse(await fs.readFile('.example.json', 'utf8'));
const knowledge = profile === 'knowledge-assistant';
const output = knowledge ? 'Answer: The demo library is open 09:00–17:00.'
  : JSON.stringify({ title: 'Demo library', summary: 'Open daily from 09:00 to 17:00.' });
let db, close;
before(async () => { ({ db, close } = await database()); });
after(async () => close?.());

async function compose({ pricing, inputVersion, provider, auth: suppliedAuth } = {}) {
  const userId = randomUUID();
  await db.query('INSERT INTO users(id) VALUES($1)', [userId]);
  const { token, auth } = identity(userId);
  if (!knowledge) await grantCredits({ db, userId, credits: 100, creditType: 'purchased', idempotencyKey: randomUUID() });
  else await getCreditBalance({ db, userId }); // Create the zero account, never a credit grant.
  const calls = [];
  const callAIStream = async args => {
    calls.push(args);
    assert.equal(args.options.maxOutputTokens, LIMITS.maxOutputTokens);
    assert.equal(args.options.maxOutputTokensCap, LIMITS.maxOutputTokens);
    assert.ok(args.signal instanceof AbortSignal);
    assert.match(args.systemPrompt, /supplied material/);
    if (provider) return provider(args);
    await args.onText(output);
    // Simulates reported usage to exercise provenance; no external provider is called.
    return { usage: { source: 'provider', inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
  };
  const start = overrides => listen(createExampleServer({ db, env: environment, auth: suppliedAuth || auth,
    callAIStream, pricing, inputVersion, ...overrides }), token);
  return { userId, auth, calls, start, api: await start() };
}

// These run inside the independently installed generated consumer, not the source workspace.
test(`${profile}: installed artifact identity, no editable core and no idle Clerk dependency`, async () => {
  assert.equal(process.versions.node.split('.')[0], '24');
  await assert.rejects(fs.access('packages'), { code: 'ENOENT' });
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
  assert.equal(Object.keys(lock.packages).some(p => p.includes('node_modules/@clerk/')), false);
  await assert.rejects(import('@clerk/backend'), { code: 'ERR_MODULE_NOT_FOUND' });
  const pin = JSON.parse(await fs.readFile('.core-release.json', 'utf8'));
  const bundle = path.dirname(path.resolve(pin.manifest));
  const manifest = await verifyBundle(bundle, { allowDevelopment: process.env.ALLOW_DEVELOPMENT_BUNDLE === 'true' });
  assert.equal(pin.sourceCommit, manifest.sourceCommit);
  assert.equal(pin.manifestIntegrity, digest(await fs.readFile(pin.manifest), 'sha256'));
  for (const component of manifest.packages) {
    await import(component.name);
    const installed = lock.packages[`node_modules/${component.name}`];
    assert.equal(installed.integrity, component.integrity);
    assert.equal(installed.link, undefined);
    const actual = await fs.realpath(`node_modules/${component.name}`);
    assert.ok(actual.startsWith(root + path.sep));
  }
  await assert.rejects(import('@yuva/ai-engine/src/agentRuntime.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  for (const name of ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(process.env[name], undefined);
});

test(`${profile}: verified identity is mandatory, invalid and unmapped callers never execute`, async () => {
  assert.throws(() => createExampleServer({ db, env: environment }), /trusted verifyRequest/);
  const app = await compose();
  try {
    for (const authorization of ['', 'Bearer not-a-credential']) {
      assert.equal((await app.api.send(input(), authorization)).status, 401);
    }
    const rejected = await app.start({ auth: { ...app.auth, findUser: async () => null } });
    try {
      const response = await rejected.send(input());
      assert.equal(response.status, 409); assert.match(response.text, /profile_required/);
    } finally { await rejected.close(); }
    assert.equal(app.calls.length, 0);
    assert.equal((await db.query('SELECT id FROM ai_operations WHERE account_id=$1', [app.userId])).rowCount, 0);
  } finally { await app.api.close(); }
});

test(`${profile}: product material schema and buffered output validation run before fulfillment`, async () => {
  const app = await compose({ provider: async ({ onText }) => {
    await onText('invalid fixture output');
    return { usage: { source: 'provider', inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
  } });
  try {
    const invalid = await app.api.send(input({ parameters: { material: '' } }));
    assert.equal(invalid.status, 400); assert.equal(app.calls.length, 0);
    const rejected = await app.api.send(input());
    assert.match(rejected.text, /unsafe_output/);
    assert.ok(!rejected.text.includes('invalid fixture output'));
    assert.ok(!rejected.text.includes('event: done'));
    assert.equal(app.calls.length, 1);
    assert.equal((await db.query("SELECT id FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [app.userId])).rowCount, 0);
    assert.equal((await db.query('SELECT id FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=$1)', [app.userId])).rowCount, 0);
  } finally { await app.api.close(); }
});

if (knowledge) {
  test('knowledge template: explicit no-charge settlement and replay preserve every financial row', async () => {
    const app = await compose();
    try {
      const before = await finances(db, app.userId); const body = input();
      const first = await app.api.send(body); const replay = await app.api.send(body);
      assert.equal(first.status, 200); assert.match(first.text, /event: done/);
      assert.match(replay.text, /"replayed":true/); assert.equal(app.calls.length, 1);
      const row = await operation(db, app.userId, body.requestId);
      assert.equal(row.financial_status, 'no_charge'); assert.equal(row.ledger_request_id, null);
      assert.equal(row.input_version, INPUT_VERSION); assert.equal(row.quote.reserveCredits, 0);
      assert.deepEqual(await finances(db, app.userId), before);
      assert.equal((await db.query('SELECT id FROM credit_usage_allocations')).rowCount, 0);
      const usage = await createUsageStore({ db }).summary({ operationId: row.id, accountId: app.userId });
      assert.equal(usage.calls.length, 1);
      const invoke = createBudgetedProvider({ operation: operationFromRow(row), provider: 'mock', model: 'starter-local',
        now: () => new Date(row.created_at).getTime(),
        capabilities: { taskType: 'text', outputLimit: true, abort: true },
        invoke: createMeteredProvider({ store: createUsageStore({ db }), operation: operationFromRow(row),
          provider: 'mock', model: 'starter-local', invoke: async () => { throw new Error('Must not re-execute'); } }) });
      await assert.rejects(invoke({ messages: [{ role: 'user', content: 'Repeat' }] }),
        error => ['execution_calls_exceeded', 'execution_authorization_missing'].includes(error.code));
      assert.equal((await createUsageStore({ db }).summary({ operationId: row.id, accountId: app.userId })).calls.length, 1);
    } finally { await app.api.close(); }
  });

  test('knowledge template: input and deadline budgets still apply with no user charge', async () => {
    const app = await compose({ provider: async ({ signal }) => {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('synthetic timeout'), { code: 'provider_aborted' });
    } });
    try {
      const before = await finances(db, app.userId);
      const oversized = await app.api.send(input({ question: 'x'.repeat(3000) }));
      assert.equal(oversized.status, 409); assert.match(oversized.text, /execution_input_exceeded/);
      assert.equal(app.calls.length, 0);
      const body = input(); const timeout = await app.api.send(body);
      assert.ok(!timeout.text.includes('event: done')); assert.equal(app.calls.length, 1);
      assert.equal(app.calls[0].signal.aborted, true);
      await app.api.send(body); assert.equal(app.calls.length, 1);
      assert.deepEqual(await finances(db, app.userId), before);
    } finally { await app.api.close(); }
  });
} else {
  test('content template: quote and usage provenance survive new deployment prices, replay and version conflicts', async () => {
    const app = await compose(); let changed, versioned;
    try {
      const body = input({ inputVersion: 'client-cannot-select-contract' });
      const first = await app.api.send(body); assert.match(first.text, /event: done/);
      const row = await operation(db, app.userId, body.requestId);
      assert.equal(row.input_version, INPUT_VERSION); assert.equal(row.financial_status, 'settled');
      assert.equal(row.quote.reserveCredits, 3); assert.equal(row.decision.credits, 2);
      const usage = await createUsageStore({ db }).summary({ operationId: row.id, accountId: app.userId });
      assert.equal(usage.calls.length, 1);
      assert.equal(usage.calls[0].metrics.inputTokens.source, 'provider');
      assert.equal(usage.calls[0].metrics.inputTokens.value, 1000);
      assert.equal(usage.calls[0].metrics.outputTokens.value, 100);
      const before = await finances(db, app.userId);
      changed = await app.start({ pricing: { ...PRICING, inputRate: { credits: 40, tokens: 1000 } } });
      const replay = await changed.send(body); assert.match(replay.text, /"replayed":true/);
      assert.deepEqual((await operation(db, app.userId, body.requestId)).quote, row.quote);
      versioned = await app.start({ inputVersion: 'content-card-v2' });
      assert.equal((await versioned.send(body)).status, 409);
      assert.equal(app.calls.length, 1); assert.deepEqual(await finances(db, app.userId), before);
      const fresh = await versioned.send({ ...body, requestId: randomUUID() });
      assert.match(fresh.text, /event: done/); assert.equal(app.calls.length, 2);
      assert.equal((await getCreditBalance({ db, userId: app.userId })).available, 96);
    } finally { await app.api.close(); await changed?.close(); await versioned?.close(); }
  });

  test('content template: settlement outage recovers frozen quote in a separate process without another provider call', async () => {
    const app = await compose();
    try {
      await db.query(`CREATE FUNCTION reject_example_message() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic persistence outage'; END $$;
        CREATE TRIGGER reject_example_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_example_message()`);
      const body = input(); const failed = await app.api.send(body);
      assert.ok(!failed.text.includes('event: done'));
      const row = await operation(db, app.userId, body.requestId);
      assert.equal(row.financial_status, 'reconciliation_required');
      assert.equal(row.fulfillment_status, 'ready'); assert.equal(app.calls.length, 1);
      await db.query('DROP TRIGGER reject_example_message ON messages');
      await db.query("UPDATE ai_operations SET lease_expires_at=clock_timestamp()-interval '1 second', next_recovery_at=clock_timestamp() WHERE id=$1", [row.id]);
      const recover = () => JSON.parse(execFileSync(process.execPath, ['scripts/recover-operations.mjs', '--apply', '--operation', row.id],
        { encoding: 'utf8', env: { ...process.env, DATABASE_URL: db.options.connectionString }, timeout: 20000 }));
      assert.equal(recover().outcomes[0].action, 'settled'); assert.equal(recover().outcomes.length, 0);
      const recovered = await operation(db, app.userId, body.requestId);
      assert.deepEqual(recovered.quote, row.quote); assert.equal(recovered.decision.credits, 2);
      assert.match((await app.api.send(body)).text, /"replayed":true/); assert.equal(app.calls.length, 1);
      assert.equal((await db.query("SELECT id FROM credit_transactions WHERE user_id=$1 AND transaction_type='usage_charge'", [app.userId])).rowCount, 1);
      assert.equal((await getCreditBalance({ db, userId: app.userId })).available, 98);
      assert.equal((await getCreditBalance({ db, userId: app.userId })).reserved, 0);
    } finally { await db.query('DROP TRIGGER IF EXISTS reject_example_message ON messages'); await app.api.close(); }
  });
}
