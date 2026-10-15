import { createHash, randomUUID } from 'node:crypto';
import { invariant } from '@yuva/billing-core';

export const SYNTHETIC_PRODUCT = Object.freeze({ id: 'synthetic-credit-pack-v1',
  label: 'Synthetic test credit pack (no real payment)', amountMinor: 100, currency: 'USD', credits: 10, synthetic: true });
const PROVIDER = 'synthetic-checkout';
const SCHEMA = 'synthetic-checkout/v1';
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const scope = "user_id=$1 AND provider='synthetic-checkout' AND type='other' AND metadata->>'schema'='synthetic-checkout/v1' AND metadata->'synthetic'='true'::jsonb";
const columns = 'id,user_id,type,provider,status,amount_minor,currency,metadata,created_at,completed_at';
const quoteFingerprint = (product) => createHash('sha256').update(JSON.stringify([SCHEMA, product.id, product.label, product.amountMinor, product.currency, product.credits, product.synthetic])).digest('hex');
const fingerprint = (productId) => createHash('sha256').update(JSON.stringify({ schema: SCHEMA, productId })).digest('hex');
const reference = (accountId, requestId) => `${PROVIDER}:${createHash('sha256').update(JSON.stringify([accountId.toLowerCase(), requestId.toLowerCase()])).digest('hex')}`;
function outcomeUnknown() {
  const error = new Error('Synthetic checkout outcome requires a read or same-request retry');
  error.code = 'checkout_outcome_unknown'; error.status = 503;
  return error;
}
function view(row) {
  const product = row.metadata?.product;
  // v1 has one immutable synthetic quote. Fail closed instead of reflecting arbitrary DB metadata.
  invariant(row.metadata?.schema === SCHEMA && row.metadata?.synthetic === true
    && uuid(row.metadata?.requestId) && product && !Array.isArray(product)
    && Object.keys(product).sort().join(',') === Object.keys(SYNTHETIC_PRODUCT).sort().join(',')
    && Object.entries(SYNTHETIC_PRODUCT).every(([key, value]) => product[key] === value)
    && Number.isSafeInteger(product.amountMinor) && product.amountMinor > 0
    && Number.isSafeInteger(product.credits) && product.credits > 0
    && row.amount_minor === product.amountMinor && row.currency === product.currency
    && row.metadata.fingerprint === fingerprint(product.id)
    && row.metadata.quoteFingerprint === quoteFingerprint(product), 'invalid_request:order_reconciliation_required', 409);
  // Only explicitly recognized local states are projected. External/unknown values are never paid.
  const status = ['pending', 'cancelled'].includes(row.status) ? row.status : 'reconciliation_required';
  return { mock: true, orderId: row.id, requestId: row.metadata.requestId, status,
    product: { id: product.id, label: product.label, amountMinor: product.amountMinor,
      currency: product.currency, credits: product.credits, synthetic: true },
    createdAt: row.created_at, cancelledAt: status === 'cancelled' ? row.completed_at : null, creditsGranted: 0 };
}

/** Product-owned synthetic records only. No vendor, payment settlement, or credit grant path. */
export function createMockCheckout({ db }) {
  async function readRow(accountId, orderId) {
    invariant(uuid(accountId) && uuid(orderId), 'invalid_request:order_not_found', 404);
    const { rows } = await db.query(`SELECT ${columns} FROM payments WHERE ${scope} AND id=$2`, [accountId, orderId]);
    invariant(rows[0], 'invalid_request:order_not_found', 404);
    return rows[0];
  }
  return {
    products: () => ({ mock: true, products: [SYNTHETIC_PRODUCT] }),
    async create({ accountId, productId, requestId }) {
      invariant(uuid(accountId) && uuid(requestId) && typeof productId === 'string' && productId.length <= 100,
        'invalid_request', 422);
      const providerReference = reference(accountId, requestId);
      const readExisting = async () => (await db.query(`SELECT ${columns} FROM payments WHERE ${scope} AND provider_reference=$2`,
        [accountId, providerReference])).rows[0];
      const replay = (row) => {
        invariant(row.metadata.fingerprint === fingerprint(productId), 'invalid_request:idempotency_conflict', 409);
        return view(row);
      };
      const existing = await readExisting();
      if (existing) return replay(existing);
      invariant(productId === SYNTHETIC_PRODUCT.id, 'invalid_request:unknown_product', 422);
      const metadata = { schema: SCHEMA, synthetic: true, requestId: requestId.toLowerCase(),
        fingerprint: fingerprint(productId), quoteFingerprint: quoteFingerprint(SYNTHETIC_PRODUCT), product: SYNTHETIC_PRODUCT };
      let inserted;
      try {
        // One atomic autocommit write: concurrent duplicates converge via the existing unique reference.
        inserted = await db.query(`INSERT INTO payments(id,user_id,type,provider,provider_reference,status,amount_minor,currency,metadata)
          VALUES($1,$2,'other',$3,$4,'pending',$5,$6,$7::jsonb)
          ON CONFLICT(provider_reference) DO NOTHING RETURNING ${columns}`,
        [randomUUID(), accountId, PROVIDER, providerReference, SYNTHETIC_PRODUCT.amountMinor,
          SYNTHETIC_PRODUCT.currency, JSON.stringify(metadata)]);
      } catch { throw outcomeUnknown(); }
      if (inserted.rows[0]) return view(inserted.rows[0]);
      // Separate statement gets a fresh snapshot after a concurrent winner commits.
      let winner;
      try { winner = await readExisting(); } catch { throw outcomeUnknown(); }
      invariant(winner, 'invalid_request:idempotency_conflict', 409);
      return replay(winner);
    },
    async get({ accountId, orderId }) { return view(await readRow(accountId, orderId)); },
    async list({ accountId, limit = 20, offset = 0 }) {
      invariant(uuid(accountId) && Number.isInteger(limit) && limit >= 1 && limit <= 50
        && Number.isInteger(offset) && offset >= 0 && offset <= 10000, 'invalid_request', 422);
      const { rows } = await db.query(`SELECT ${columns} FROM payments WHERE ${scope} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
        [accountId, limit + 1, offset]);
      return { mock: true, orders: rows.slice(0, limit).map(view), page: { limit, offset, hasMore: rows.length > limit } };
    },
    async cancel({ accountId, orderId }) {
      // Read ownership before mutation; predicate still enforces ownership and state atomically.
      const existing = await readRow(accountId, orderId);
      view(existing); // Reject malformed snapshots before any write.
      if (existing.status === 'cancelled') return view(existing);
      invariant(existing.status === 'pending', 'invalid_request:order_not_pending', 409);
      let result;
      try {
        result = await db.query(`UPDATE payments SET status='cancelled',completed_at=clock_timestamp()
          WHERE ${scope} AND id=$2 AND status='pending' AND metadata=$3::jsonb AND amount_minor=$4 AND currency=$5
          RETURNING ${columns}`, [accountId, orderId, JSON.stringify(existing.metadata), existing.amount_minor, existing.currency]);
      } catch { throw outcomeUnknown(); }
      if (result.rows[0]) return view(result.rows[0]);
      const current = await readRow(accountId, orderId);
      view(current);
      invariant(current.status === 'cancelled', 'invalid_request:order_not_pending', 409);
      return view(current);
    },
  };
}

export function configuredMockCheckout({ env, db }) {
  if (!env.MOCK_CHECKOUT || env.MOCK_CHECKOUT === 'disabled') return null;
  if (env.MOCK_CHECKOUT !== 'local-development' || !['development', 'test'].includes(env.NODE_ENV)
    || env.MOCK_CHECKOUT_DISPOSABLE_DB !== 'acknowledged') throw new Error('Invalid local synthetic checkout configuration');
  let origin;
  try { origin = new URL(env.MOCK_CHECKOUT_TRUSTED_ORIGIN); } catch { throw new Error('Synthetic checkout requires an explicit trusted loopback origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || origin.origin !== env.MOCK_CHECKOUT_TRUSTED_ORIGIN) throw new Error('Synthetic checkout requires an exact loopback origin');
  return { ...createMockCheckout({ db }), trustedOrigin: origin.origin };
}
