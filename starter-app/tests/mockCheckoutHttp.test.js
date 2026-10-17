import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../server/index.js';
import { createMockCheckout, SYNTHETIC_PRODUCT } from '../server/application/mockCheckout.js';
import { isolatedDatabase } from './helpers/database.js';

// Real PostgreSQL and HTTP; all users/orders are disposable local synthetic fixtures.
describe('synthetic checkout: PostgreSQL persistence and authenticated HTTP', () => {
  let db, close, account, foreign;
  const servers = [];
  const origin = 'http://localhost:5173';
  const env = { NODE_ENV: 'test', AI_PROVIDER: 'mock', MOCK_CHECKOUT: 'local-development',
    MOCK_CHECKOUT_DISPOSABLE_DB: 'acknowledged', MOCK_CHECKOUT_TRUSTED_ORIGIN: origin, OPERATIONS_VIEW: 'read-only' };
  beforeAll(async () => {
    ({ db, close } = await isolatedDatabase());
    [account, foreign] = [randomUUID(), randomUUID()];
    for (const id of [account, foreign]) await db.query('INSERT INTO users(id) VALUES($1)', [id]);
  });
  afterAll(async () => {
    for (const server of servers) { const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed; }
    await close?.();
  });
  async function app(extraEnv = {}) {
    const server = createServer({ db, config: { env: { ...env, ...extraEnv } }, auth: {
      verifyRequest: async (req) => req.headers['x-fixture-id'] ? { kind: 'authenticated', userId: req.headers['x-fixture-id'] } : { kind: 'missing' },
      findUser: async (id) => [account, foreign].includes(id) ? { id } : null,
    } }).listen(0, '127.0.0.1');
    servers.push(server); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`;
  }
  const headers = (id = account) => ({ 'content-type': 'application/json', 'x-fixture-id': id, origin });
  const input = () => ({ productId: SYNTHETIC_PRODUCT.id, requestId: randomUUID() });
  const post = (base, path, body, options = {}) => fetch(`${base}/api/mock-checkout${path}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body), ...options,
  });
  const get = (base, path, id = account) => fetch(`${base}/api/mock-checkout${path}`, { headers: headers(id) });
  async function snapshotExceptOrders() {
    const { rows: tables } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'payments' ORDER BY tablename");
    const result = {};
    for (const { tablename } of tables) result[tablename] = (await db.query(`SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  }

  it('converges concurrent HTTP creates on one persisted quote and replays after app restart', async () => {
    const base = await app(), body = input();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(base, '/orders', body)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const orders = await Promise.all(responses.map((response) => response.json()));
    for (const order of orders) expect(order).toEqual(orders[0]);
    expect(orders[0]).toMatchObject({ mock: true, status: 'pending', product: SYNTHETIC_PRODUCT, creditsGranted: 0 });
    expect((await db.query("SELECT id FROM payments WHERE metadata->>'requestId'=$1", [body.requestId])).rows).toHaveLength(1);
    const restarted = await app();
    expect(await (await post(restarted, '/orders', body)).json()).toEqual(orders[0]);
    expect((await post(restarted, '/orders', { ...body, productId: 'changed-product' })).status).toBe(409);
  });

  it('isolates accounts, hides foreign IDs, rejects client prices, and retains independent read routes', async () => {
    const base = await app(), body = input();
    const own = await (await post(base, '/orders', body)).json();
    const other = await (await post(base, '/orders', body, { headers: headers(foreign) })).json();
    expect(other.orderId).not.toBe(own.orderId);
    expect((await get(base, `/orders/${own.orderId}`, foreign)).status).toBe(404);
    expect((await post(base, `/orders/${own.orderId}/cancel`, {}, { headers: headers(foreign) })).status).toBe(404);
    const history = await (await get(base, '/orders?limit=50', foreign)).json();
    expect(history.orders.map((order) => order.orderId)).toContain(other.orderId);
    expect(history.orders.map((order) => order.orderId)).not.toContain(own.orderId);
    for (const extra of [{ amountMinor: 1 }, { currency: 'EUR' }, { credits: 99 }, { accountId: foreign }, { status: 'paid' }]) {
      expect((await post(base, '/orders', { ...input(), ...extra })).status).toBe(422);
    }
    expect((await fetch(`${base}/api/operations`, { headers: headers() })).status).toBe(200);
    expect((await fetch(`${base}/api/ops/operations`, { headers: headers() })).status).toBe(403);
  });

  it('requires explicit enablement, authentication and mutation origin before writes', async () => {
    const base = await app(), before = (await db.query('SELECT count(*) FROM payments')).rows;
    expect((await get(await app({ MOCK_CHECKOUT: 'disabled' }), '/products')).status).toBe(404);
    expect((await fetch(`${base}/api/mock-checkout/products`)).status).toBe(401);
    for (const requestHeaders of [{ 'content-type': 'application/json', origin },
      { 'content-type': 'application/json', 'x-fixture-id': account },
      { ...headers(), origin: 'http://127.0.0.1:5173' }, { ...headers(), origin: 'https://evil.example' }]) {
      expect([401, 403]).toContain((await post(base, '/orders', input(), { headers: requestHeaders })).status);
    }
    const response = await get(base, '/products');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await db.query('SELECT count(*) FROM payments')).rows).toEqual(before);
  });

  it('keeps all non-order tables unchanged across create, replay, list, read and concurrent cancellation', async () => {
    const base = await app(), before = await snapshotExceptOrders(), body = input();
    const order = await (await post(base, '/orders', body)).json();
    await post(base, '/orders', body);
    await get(base, '/orders'); await get(base, `/orders/${order.orderId}`);
    const results = await Promise.all(Array.from({ length: 6 }, () => post(base, `/orders/${order.orderId}/cancel`, {})));
    expect(results.every((response) => response.status === 200)).toBe(true);
    const cancelled = await Promise.all(results.map((response) => response.json()));
    for (const result of cancelled) expect(result).toEqual(cancelled[0]);
    expect(cancelled[0]).toMatchObject({ orderId: order.orderId, status: 'cancelled', creditsGranted: 0 });
    expect(cancelled[0].cancelledAt).toBeTruthy();
    expect(await (await post(base, '/orders', body)).json()).toEqual(cancelled[0]);
    expect(await snapshotExceptOrders()).toEqual(before);
  });

  it('recovers a real committed INSERT and UPDATE after lost acknowledgements without duplicates', async () => {
    for (const operation of ['INSERT', 'UPDATE']) {
      let injected = false;
      const flaky = { query: async (sql, args) => {
        const result = await db.query(sql, args);
        if (!injected && sql.startsWith(operation)) { injected = true; throw new Error('simulated lost acknowledgement after real commit'); }
        return result;
      } };
      const checkout = createMockCheckout({ db: flaky }), body = { accountId: account, ...input() };
      let order;
      if (operation === 'INSERT') {
        await expect(checkout.create(body)).rejects.toMatchObject({ code: 'checkout_outcome_unknown', status: 503 });
        order = await createMockCheckout({ db }).create(body);
      } else {
        order = await checkout.create(body);
        await expect(checkout.cancel({ accountId: account, orderId: order.orderId })).rejects.toMatchObject({ code: 'checkout_outcome_unknown', status: 503 });
        expect(await createMockCheckout({ db }).cancel({ accountId: account, orderId: order.orderId })).toMatchObject({ status: 'cancelled' });
      }
      expect(injected).toBe(true);
      expect((await db.query("SELECT id FROM payments WHERE metadata->>'requestId'=$1", [body.requestId])).rows).toEqual([{ id: order.orderId }]);
    }
  });

  it('fails closed on corrupt quote or unknown status and never interprets a return URL as payment', async () => {
    const base = await app();
    const corrupt = await (await post(base, '/orders', input())).json();
    await db.query('UPDATE payments SET amount_minor=101 WHERE id=$1', [corrupt.orderId]);
    expect((await get(base, `/orders/${corrupt.orderId}`)).status).toBe(409);
    expect((await post(base, `/orders/${corrupt.orderId}/cancel`, {})).status).toBe(409);
    expect((await db.query('SELECT status FROM payments WHERE id=$1', [corrupt.orderId])).rows[0].status).toBe('pending');
    const unknown = await (await post(base, '/orders', input())).json();
    await db.query("UPDATE payments SET status='paid' WHERE id=$1", [unknown.orderId]);
    expect(await (await get(base, `/orders/${unknown.orderId}`)).json()).toMatchObject({ status: 'reconciliation_required', creditsGranted: 0 });
    expect((await post(base, `/orders/${unknown.orderId}/cancel`, {})).status).toBe(409);
    expect((await get(base, `/orders/${unknown.orderId}?status=paid&success=true`)).status).toBe(422);
  });
});
