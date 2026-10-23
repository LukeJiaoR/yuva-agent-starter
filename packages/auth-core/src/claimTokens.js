import crypto from 'node:crypto';

export const DEFAULT_ANON_COOKIE_NAME = 'app_anon';
const DEFAULT_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export function getClaimSecret(env = process.env) {
  if (env.NODE_ENV === 'production' && !env.CLAIM_TOKEN_SECRET && !env.UNSUBSCRIBE_SECRET) {
    throw new Error('CLAIM_TOKEN_SECRET or UNSUBSCRIBE_SECRET is required in production');
  }
  return (
    env.CLAIM_TOKEN_SECRET ||
    env.UNSUBSCRIBE_SECRET ||
    'dev-only-claim-secret'
  );
}

export function hashSecret(raw, env = process.env) {
  const secret = getClaimSecret(env);
  return crypto
    .createHmac('sha256', secret)
    .update(String(raw || ''))
    .digest('hex');
}

export function createClaimToken({ ttlDays = 14, idempotencySeed = null, env = process.env } = {}) {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw new TypeError('Claim token TTL must be a positive finite number');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime())) throw new RangeError('Claim token expiry is out of range');
  const secret = getClaimSecret(env);
  const raw = idempotencySeed
    ? crypto.createHmac('sha256', secret)
      .update(`claim-token:v1:${String(idempotencySeed)}`)
      .digest('base64url')
    : crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashSecret(raw, env), expiresAt };
}

export function verifyClaimToken(raw, expectedHash, expiresAt, env = process.env) {
  if (!raw || !expectedHash || !expiresAt) return false;
  if (!(expiresAt instanceof Date) && !['string', 'number'].includes(typeof expiresAt)) return false;
  const expiry = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  const actual = Buffer.from(hashSecret(raw, env));
  const expected = Buffer.from(String(expectedHash));
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

export function anonymousCookieOptions({
  nodeEnv = process.env.NODE_ENV,
  domain = process.env.ANON_COOKIE_DOMAIN || process.env.COOKIE_DOMAIN,
  maxAgeMs = DEFAULT_COOKIE_MAX_AGE_MS,
} = {}) {
  const opts = {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
  if (domain && !String(domain).includes('localhost')) opts.domain = domain;
  return opts;
}

export function anonymousCookieClearOptions(options = {}) {
  const { maxAge: _maxAge, ...clearOptions } = anonymousCookieOptions(options);
  return clearOptions;
}
