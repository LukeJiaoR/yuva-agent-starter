import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createMockCheckout, configuredMockCheckout, SYNTHETIC_PRODUCT } from '../server/application/mockCheckout.js';
import { createMockCheckoutRoutes } from '../server/routes/mockCheckout.routes.js';
import { toPublicError } from '../server/http/errors.js';

// Source-only coverage added for later execution. No database, vendor, or credit adapter is used.
const accountId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const env = { NODE_ENV: 'test', MOCK_CHECKOUT: 'local-development', MOCK_CHECKOUT_DISPOSABLE_DB: 'acknowledged',
  MOCK_CHECKOUT_TRUSTED_ORIGIN: 'http://localhost:5173' };
const input = { accountId, requestId, productId: SYNTHETIC_PRODUCT.id };
function row(status = 'pending') {
  return { id: orderId, status, amount_minor: 100, currency: 'USD', created_at: '2026-01-01T00:00:00Z', completed_at: null,
    metadata: { synthetic: true, schema: 'synthetic-checkout/v1', requestId, fingerprint: createHash('sha256').update(JSON.stringify({schema:'synthetic-checkout/v1',productId:SYNTHETIC_PRODUCT.id})).digest('hex'),
      quoteFingerprint: createHash('sha256').update(JSON.stringify(['synthetic-checkout/v1', SYNTHETIC_PRODUCT.id, SYNTHETIC_PRODUCT.label, 100, 'USD', 10, true])).digest('hex'), product: { ...SYNTHETIC_PRODUCT } } };
}

describe('local synthetic checkout contract (no financial effects)', () => {
  it('defaults off and requires explicit local mode, DB acknowledgement and exact loopback origin', () => {
    const db = { query: vi.fn() };
    expect(configuredMockCheckout({ env: {}, db })).toBeNull();
    for (const invalid of [{ NODE_ENV: 'production' }, { NODE_ENV: 'staging' }, { MOCK_CHECKOUT: 'true' },
      { MOCK_CHECKOUT_DISPOSABLE_DB: undefined }, { MOCK_CHECKOUT_TRUSTED_ORIGIN: 'http://localhost:5173/' },
      { MOCK_CHECKOUT_TRUSTED_ORIGIN: 'https://example.com' }, { MOCK_CHECKOUT_TRUSTED_ORIGIN: 'http://x@localhost:5173' }]) {
      expect(() => configuredMockCheckout({ env: { ...env, ...invalid }, db })).toThrow();
    }
    expect(configuredMockCheckout({ env, db }).products().products).toEqual([SYNTHETIC_PRODUCT]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('freezes the server product and reuses the account/request reference without another insert', async () => {
    let saved;
    const db = { query: vi.fn(async (sql, args) => {
      if (sql.startsWith('SELECT')) return { rows: saved ? [saved] : [] };
      expect(sql).toContain("'other'"); expect(sql).toContain('ON CONFLICT(provider_reference) DO NOTHING');
      saved = { ...row(), id: args[0], metadata: JSON.parse(args[6]) };
      expect(args[4]).toBe(100); expect(args[5]).toBe('USD');
      return { rows: [saved] };
    }) };
    const checkout = createMockCheckout({ db });
    const first = await checkout.create(input);
    expect(first).toMatchObject({ mock: true, status: 'pending', creditsGranted: 0, product: SYNTHETIC_PRODUCT });
    expect(await checkout.create(input)).toEqual(first);
    await expect(checkout.create({ ...input, productId: 'changed-pack' })).rejects.toMatchObject({ status: 409 });
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1);
    for (const [sql] of db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT'))) {
      expect(sql).toContain('user_id=$1'); expect(sql).toContain("provider='synthetic-checkout'");
      expect(sql).toContain("metadata->>'schema'='synthetic-checkout/v1'");
      expect(sql).toContain("metadata->'synthetic'='true'::jsonb");
    }
  });

  it('scopes deterministic references by account and never accepts client price fields at the route', async () => {
    const refs = [];
    const db = { query: vi.fn(async (sql, args) => {
      if (sql.startsWith('SELECT')) return { rows: [] };
      refs.push(args[3]); return { rows: [{ ...row(), id: args[0], metadata: JSON.parse(args[6]) }] };
    }) };
    const checkout = createMockCheckout({ db });
    await checkout.create(input);
    await checkout.create({ ...input, accountId: '44444444-4444-4444-8444-444444444444' });
    expect(refs[0]).not.toEqual(refs[1]);
    const router = createMockCheckoutRoutes({ checkout });
    const post = router.stack.find((layer) => layer.route?.path === '/api/mock-checkout/orders' && layer.route.methods.post);
    const next = vi.fn();
    await post.route.stack[0].handle({ user: { id: accountId }, body: { ...input, amountMinor: 1 } }, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 422 });
  });

  it('fails closed for non-loopback, guests and missing/untrusted mutation Origin', () => {
    const router = createMockCheckoutRoutes({ checkout: { trustedOrigin: env.MOCK_CHECKOUT_TRUSTED_ORIGIN } });
    const gate = router.stack[0].handle;
    for (const override of [{ socket: { remoteAddress: '192.0.2.1' } }, { auth: { kind: 'guest' } },
      { headers: {} }, { headers: { origin: 'https://evil.example' } }]) {
      const req = { method: 'POST', query: {}, path: '/orders', socket: { remoteAddress: '127.0.0.1' }, auth: { kind: 'authenticated' },
        user: { id: accountId }, headers: { origin: env.MOCK_CHECKOUT_TRUSTED_ORIGIN }, ...override };
      const res = { set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() }, next = vi.fn();
      gate(req, res, next); expect(next).not.toHaveBeenCalled(); expect(res.json).toHaveBeenCalled();
    }
  });

  it('reports ambiguous writes without changing the client request identity or leaking causes', async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('private database details')) };
    let failure;
    try { await createMockCheckout({ db }).create(input); } catch (error) { failure = error; }
    expect(toPublicError(failure)).toMatchObject({ status: 503, code: 'checkout_outcome_unknown' });
    expect(JSON.stringify(toPublicError(failure))).not.toContain('private database');
  });

  it('only cancels pending, keeps cancellation idempotent, and never turns unknown states into paid', async () => {
    for (const status of ['paid', 'refunded', 'unrecognized']) {
      const db = { query: vi.fn().mockResolvedValue({ rows: [row(status)] }) };
      const checkout = createMockCheckout({ db });
      expect(await checkout.get({ accountId, orderId })).toMatchObject({ status: 'reconciliation_required', creditsGranted: 0 });
      await expect(checkout.cancel({ accountId, orderId })).rejects.toMatchObject({ status: 409 });
      expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    }
    const db = { query: vi.fn().mockResolvedValue({ rows: [row('cancelled')] }) };
    expect(await createMockCheckout({ db }).cancel({ accountId, orderId })).toMatchObject({ status: 'cancelled' });
    expect(db.query).toHaveBeenCalledTimes(1);
    const pendingDb = { query: vi.fn().mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [row('cancelled')] }) };
    await createMockCheckout({ db: pendingDb }).cancel({ accountId, orderId });
    expect(pendingDb.query.mock.calls[1][0]).toContain("AND status='pending'");
  });

  it('converges after a conflicting insert and after committed-write acknowledgement loss', async () => {
    const winner = row();
    const concurrentDb = { query: vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [winner] }) };
    expect(await createMockCheckout({ db: concurrentDb }).create(input)).toMatchObject({ orderId, status: 'pending' });
    expect(concurrentDb.query.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['SELECT', 'INSERT', 'SELECT']);
    let saved;
    const uncertainDb = { query: vi.fn(async (sql, args) => {
      if (sql.startsWith('SELECT')) return { rows: saved ? [saved] : [] };
      saved = { ...row(), id: args[0], metadata: JSON.parse(args[6]) };
      throw new Error('acknowledgement lost after commit');
    }) };
    const checkout = createMockCheckout({ db: uncertainDb });
    await expect(checkout.create(input)).rejects.toMatchObject({ code: 'checkout_outcome_unknown' });
    expect(await checkout.create(input)).toMatchObject({ orderId: saved.id, requestId });
    expect(uncertainDb.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1);
  });

  it('rejects malformed frozen quotes before cancelling and never reflects arbitrary labels', async () => {
    for (const corrupt of [
      { ...row(), amount_minor: 101 },
      { ...row(), metadata: { ...row().metadata, product: { ...SYNTHETIC_PRODUCT, label: 'private untrusted label' } } },
      { ...row(), metadata: { ...row().metadata, quoteFingerprint: 'wrong' } },
      { ...row(), metadata: { ...row().metadata, requestId: 'bad' } },
    ]) {
      const db = { query: vi.fn().mockResolvedValue({ rows: [corrupt] }) };
      const checkout = createMockCheckout({ db });
      await expect(checkout.get({ accountId, orderId })).rejects.toMatchObject({ code: 'invalid_request:order_reconciliation_required', status: 409 });
      await expect(checkout.cancel({ accountId, orderId })).rejects.toMatchObject({ status: 409 });
      expect(db.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    }
  });

  it('bounds history and hides absent/foreign orders', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) }, checkout = createMockCheckout({ db });
    await expect(checkout.get({ accountId, orderId })).rejects.toMatchObject({ status: 404 });
    for (const invalid of [{ limit: 51 }, { offset: 10001 }, { limit: 0 }, { offset: -1 }]) {
      await expect(checkout.list({ accountId, ...invalid })).rejects.toMatchObject({ status: 422 });
    }
    expect(await checkout.list({ accountId })).toEqual({ mock: true, orders: [], page: { limit: 20, offset: 0, hasMore: false } });
  });
});
