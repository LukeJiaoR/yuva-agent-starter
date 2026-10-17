import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createServer } from '../server/index.js';
import { createOperationsReadStore } from '../server/stores/operationsReadStore.js';
import { isolatedDatabase, quoteFixture } from './helpers/database.js';

// All accounts, prompts, usage and financial records below are synthetic isolated-schema fixtures.
describe('read-only operation timeline: real PostgreSQL and authenticated HTTP', () => {
  let db, close, account, foreign, operator, operationId, otherOperation, ledgerId;
  const servers = [], sentinel = 'SENSITIVE_SENTINEL_DO_NOT_EXPOSE';
  beforeAll(async () => {
    ({ db, close } = await isolatedDatabase());
    [account, foreign, operator, operationId, otherOperation, ledgerId] = Array.from({ length: 6 }, () => randomUUID());
    for (const id of [account, foreign, operator]) await db.query('INSERT INTO users(id) VALUES($1)', [id]);
    await db.query(`INSERT INTO credit_usage_requests(id,user_id,feature_key,client_request_id,idempotency_key,status,assistant_text,metadata)
      VALUES($1,$2,'fixture',$3,$3,'reconciliation_required',$4,$5)`, [ledgerId, account, randomUUID(), sentinel, { token: sentinel }]);
    const quote = { ...quoteFixture(2), token: sentinel, prompt: sentinel,
      limits: { paths: [{ provider: 'mock', model: 'fixture', apiKey: sentinel }], secret: sentinel } };
    const fulfillment = { status: 'failed', prompt: sentinel, artifacts: [{ id: 'art_fixture', type: 'image', state: 'failed',
      specs: { mediaType: 'image/png', sizeBytes: 42, secret: sentinel }, storageKey: sentinel, sourceUrl: sentinel, text: sentinel }] };
    for (const [id, owner, ledger, status] of [[operationId, account, ledgerId, 'reconciliation_required'], [otherOperation, foreign, null, 'settled']]) {
      await db.query(`INSERT INTO ai_operations(id,account_id,client_request_id,feature_key,task_type,execution_mode,input_version,input_fingerprint,
        quote,ledger_request_id,execution_status,financial_status,fulfillment_status,fulfillment,created_at,recovery_deadline_at,
        recovery_error,manual_review,reconciliation_reason,recovery_attempts)
        VALUES($1,$2,$3,'fixture','image','async','1',$4,$5,$6,'submission_unknown',$7,'failed',$8,NOW()-interval '9 days',
        NOW()-interval '2 days','artifact_storage_failed',true,'ledger_state_conflict',3)`,
      [id, owner, randomUUID(), '0'.repeat(64), quote, ledger, status, fulfillment]);
    }
    for (const [attempt, cost] of [[1, null], [2, { amount: '0', scale: 6, currency: 'USD', source: 'provider', status: 'observed' }],
      [3, { amount: '123', scale: 2, currency: 'EUR', source: 'estimate', status: 'estimated' }],
      [4, { amount: '7', scale: 3, currency: 'USD', source: 'provider', status: 'reconciled' }]]) {
      const callId = randomUUID();
      await db.query(`INSERT INTO ai_provider_calls(id,operation_id,attempt,provider,model,outcome,metrics,cost,failure_code,provider_request_id)
        VALUES($1,$2,$3,'mock','fixture','unknown',$4,$5,$6,$6)`, [callId, operationId, attempt,
        { images: { value: 0, unit: 'image', source: 'provider', token: sentinel }, private: sentinel }, cost && { ...cost, token: sentinel }, sentinel]);
      await db.query('INSERT INTO ai_usage_observations(call_id,digest,observation) VALUES($1,$2,$3)', [callId, String(attempt).repeat(64), { secret: sentinel }]);
    }
    await db.query(`INSERT INTO credit_transactions(user_id,usage_request_id,amount,transaction_type,idempotency_key,metadata,reason)
      VALUES($1,$2,2,'usage_reserve',$3,$4,$5)`, [account, ledgerId, randomUUID(), { secret: sentinel }, sentinel]);
    await db.query(`INSERT INTO ai_recovery_events(operation_id,execution_epoch,action,reason) VALUES($1,1,'manual_review',$2)`, [operationId, sentinel]);
    await db.query(`INSERT INTO admin_audit_logs(actor_email,action,target_type,target_id,environment,request_id,reason,status,before_snapshot,metadata)
      VALUES($1,'private_action','operation',$2,'test',$3,$1,'needs_reconciliation',$4,$4)`, [sentinel, operationId, randomUUID(), { secret: sentinel }]);
  });
  afterAll(async () => {
    for (const server of servers) { const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed; }
    await close?.();
  });
  const resolver = ({ user }) => user.id === operator ? ['operations:read:any'] : [];
  async function app({ capabilities = resolver, enabled = 'read-only' } = {}) {
    const server = createServer({ db, config: { env: { NODE_ENV: 'test', AI_PROVIDER: 'mock', OPERATIONS_VIEW: enabled }, operationsReadCapabilities: capabilities },
      auth: { verifyRequest: async (req) => req.headers['x-fixture-id'] ? { kind: 'authenticated', userId: req.headers['x-fixture-id'], token: sentinel } : { kind: 'missing' },
        findUser: async (id) => [account, foreign, operator].includes(id) ? { id, role: 'super_admin', private: sentinel } : null } }).listen(0, '127.0.0.1');
    servers.push(server); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`;
  }
  const get = (base, path, user = account, extra = {}) => fetch(base + path, { headers: { ...(user && { 'x-fixture-id': user }), ...extra } });

  it('defaults disabled, distinguishes authentication and operator authorization, ignores forged role/capabilities', async () => {
    expect((await get(await app({ enabled: null }), '/api/operations')).status).toBe(404);
    expect((await get(await app({ enabled: 'disabled' }), '/api/operations')).status).toBe(404);
    const base = await app();
    expect((await get(base, '/api/operations', null)).status).toBe(401);
    expect((await get(base, '/api/ops/operations', null)).status).toBe(401);
    expect((await get(base, '/api/ops/operations', account, { role: 'super_admin', 'x-role': 'super_admin', 'x-capabilities': 'operations:read:any' })).status).toBe(403);
    expect(await (await get(base, '/api/operations/capabilities')).json()).toEqual({ enabled: true, selfRead: true, operatorRead: false });
    expect(await (await get(base, '/api/operations/capabilities', operator)).json()).toEqual({ enabled: true, selfRead: true, operatorRead: true });
  });

  it('accepts only an explicit exact trusted capability array and supplies no raw request/token/profile', async () => {
    for (const value of [undefined, true, 'operations:read:any', { role: 'super_admin' }, { 'operations:read:any': true }, ['operations:read:any', 'admin'], ['super_admin'], null]) {
      expect((await get(await app({ capabilities: () => value }), '/api/ops/operations', operator)).status).toBe(403);
    }
    expect((await get(await app({ capabilities: () => { throw Error(sentinel); } }), '/api/ops/operations', operator)).status).toBe(403);
    expect((await get(await app({ capabilities: null }), '/api/ops/operations', operator)).status).toBe(403);
    const trusted = vi.fn(resolver), base = await app({ capabilities: trusted });
    expect((await get(base, '/api/ops/operations', operator)).status).toBe(200);
    expect(trusted).toHaveBeenCalledWith({ auth: { kind: 'authenticated', userId: operator }, user: { id: operator } });
    expect(Object.isFrozen(trusted.mock.calls[0][0].user)).toBe(true);
  });

  it('pins self reads to verified local account and exposes cross-account only to trusted operators', async () => {
    const base = await app();
    const self = await (await get(base, '/api/operations')).json();
    expect(self.items.map((x) => x.operationId)).toEqual([operationId]);
    expect((await get(base, `/api/operations/${otherOperation}`)).status).toBe(404);
    expect((await get(base, `/api/operations?accountId=${foreign}`)).status).toBe(422);
    expect((await get(base, `/api/operations/${operationId}?accountId=${foreign}`)).status).toBe(422);
    const result = await (await get(base, `/api/ops/operations?accountId=${foreign}&status=settled`, operator)).json();
    expect(result.items.map((x) => x.operationId)).toEqual([otherOperation]);
    expect((await get(base, `/api/ops/operations/${otherOperation}`, operator)).status).toBe(200);
  });

  it('bounds pagination, rejects invalid/duplicate/unknown input and exposes no write routes', async () => {
    const base = await app();
    for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=01', 'limit=2&limit=3', 'offset=10001', 'offset=-1',
      'offset=Infinity', 'limit[x]=2', 'role=super_admin', 'status=reserved', 'accountId=bad']) {
      expect((await get(base, `/api/operations?${query}`)).status, query).toBe(422);
    }
    for (const query of ['status=anything', 'accountId=bad', 'accountId[]=x', 'status=settled&status=reserved']) {
      expect((await get(base, `/api/ops/operations?${query}`, operator)).status, query).toBe(422);
    }
    expect((await get(base, '/api/operations/not-a-uuid')).status).toBe(422);
    expect((await get(base, '/api/operations/capabilities?role=admin')).status).toBe(422);
    const page = await (await get(base, '/api/ops/operations?limit=1', operator)).json();
    expect(page.items).toHaveLength(1); expect(page.page).toEqual({ limit: 1, offset: 0, hasMore: true, nextOffset: 1 });
    const next = await (await get(base, '/api/ops/operations?limit=1&offset=1', operator)).json();
    expect(next.items[0].operationId).not.toBe(page.items[0].operationId);
    expect((await fetch(base + `/api/operations/${operationId}/recover`, { method: 'POST', headers: { 'x-fixture-id': operator } })).status).toBe(404);
  });

  it('preserves unknown, zero, estimated and provider costs; safe failure metadata and unsupported payment events', async () => {
    const base = await app();
    const response = await get(base, `/api/operations/${operationId}`), result = await response.json();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(result.operation).toMatchObject({ operationId, executionStatus: 'submission_unknown', financialStatus: 'reconciliation_required',
      fulfillmentStatus: 'failed', manualReview: true, reconciliationReason: 'ledger_state_conflict' });
    expect(result.operation.pendingAgeSeconds).toBeGreaterThan(8 * 86400);
    expect(result.recovery).toMatchObject({ attempts: 3, overdue: true, reason: 'artifact_storage_failed' });
    expect(result.calls.items.map((c) => c.cost)).toEqual([
      { status: 'missing', source: 'missing', amount: null, currency: null, scale: null },
      { amount: '0', scale: 6, currency: 'USD', source: 'provider', status: 'observed' },
      { amount: '123', scale: 2, currency: 'EUR', source: 'estimate', status: 'estimated' },
      { amount: '7', scale: 3, currency: 'USD', source: 'provider', status: 'reconciled' },
    ]);
    expect(result.calls.items[0].metrics.images).toEqual({ value: 0, unit: 'image', source: 'provider' });
    expect(result.calls.items[0].metrics.inputTokens).toEqual({ value: null, unit: 'token', source: 'missing' });
    expect(result.calls.items[0].failureCode).toBe('unclassified_failure');
    expect(result.ledger.request.status).toBe('reconciliation_required');
    expect(result.ledger.transactions.items[0]).toMatchObject({ amount: 2, unit: 'credit', type: 'usage_reserve' });
    expect(result.artifacts.items[0]).toMatchObject({ state: 'failed', byteSize: 42, mimeType: 'image/png' });
    expect(result.audits.items).toHaveLength(1); expect(result.paymentEvents).toEqual({ supported: false });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toMatch(/storageKey|sourceUrl|assistant_text|provider_request_id|before_snapshot|apiKey/);
    const settled = await (await get(base, `/api/ops/operations/${otherOperation}`, operator)).json();
    expect(settled.operation.pendingAgeSeconds).toBeNull(); expect(settled.recovery.overdue).toBe(false);
  });

  it('caps every nested collection and preserves explicit truncation flags', async () => {
    const id = randomUUID(), nestedLedger = randomUUID(), artifacts = Array.from({ length: 51 }, () => ({ id: 'art_fixture', type: 'text', state: 'available', text: sentinel }));
    await db.query(`INSERT INTO credit_usage_requests(id,user_id,feature_key,client_request_id,idempotency_key) VALUES($1,$2,'fixture',$3,$3)`, [nestedLedger, foreign, randomUUID()]);
    await db.query(`INSERT INTO ai_operations(id,account_id,client_request_id,feature_key,task_type,execution_mode,input_version,input_fingerprint,quote,fulfillment,ledger_request_id)
      VALUES($1,$2,$3,'fixture','text','stream','1',$4,$5,$6,$7)`, [id, foreign, randomUUID(), '0'.repeat(64),
      { ...quoteFixture(), limits: { paths: Array.from({ length: 21 }, () => ({ provider: 'mock', model: 'fixture' })) } }, { artifacts }, nestedLedger]);
    await db.query(`INSERT INTO ai_provider_calls(id,operation_id,attempt,provider,model)
      SELECT gen_random_uuid(),$1,n,'mock','fixture' FROM generate_series(1,51) n`, [id]);
    await db.query(`INSERT INTO ai_recovery_events(operation_id,execution_epoch,action) SELECT $1,n,'claimed' FROM generate_series(1,51) n`, [id]);
    await db.query(`INSERT INTO credit_transactions(user_id,usage_request_id,idempotency_key) SELECT $1,$2,gen_random_uuid()::text FROM generate_series(1,51)`, [foreign, nestedLedger]);
    await db.query(`INSERT INTO admin_audit_logs(actor_email,action,target_type,target_id,environment,request_id,reason,status) SELECT 'fixture@example.invalid','fixture','operation',$1,'test',gen_random_uuid(),'fixture','succeeded' FROM generate_series(1,51)`, [id]);
    const result = await createOperationsReadStore({ db }).detail({ operationId: id, accountId: foreign });
    for (const collection of [result.calls, result.artifacts, result.recovery.events, result.ledger.transactions, result.audits]) { expect(collection.items).toHaveLength(50); expect(collection.truncated).toBe(true); }
    expect(result.quote.providerBinding.items).toHaveLength(20); expect(result.quote.providerBinding.truncated).toBe(true);
  });

  it('uses read-only transactions and repeated HTTP reads leave every database table unchanged', async () => {
    const snapshot = async () => {
      const { rows: tables } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename");
      const result = {};
      for (const { tablename } of tables) result[tablename] = (await db.query(`SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    };
    const before = await snapshot(), statements = [];
    const guarded = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql, values) => {
        statements.push(sql);
        if (sql.startsWith('SELECT') && !sql.includes('CURRENT_TIMESTAMP')) {
          expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
        }
        return client.query(sql, values);
      } };
    } };
    await createOperationsReadStore({ db: guarded }).detail({ operationId, accountId: account });
    const base = await app();
    for (let i = 0; i < 2; i++) {
      expect((await get(base, '/api/operations')).status).toBe(200);
      expect((await get(base, `/api/operations/${operationId}`)).status).toBe(200);
      expect((await get(base, '/api/ops/operations', operator)).status).toBe(200);
    }
    expect(statements.every((sql) => /^(SELECT|BEGIN|SET LOCAL|COMMIT)/u.test(sql))).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
