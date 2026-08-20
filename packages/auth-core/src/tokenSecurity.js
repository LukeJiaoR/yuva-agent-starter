import crypto from 'node:crypto';

export function ensureAuthTokenSecret(env = process.env) {
  if (env.NODE_ENV === 'production' && !env.AUTH_TOKEN_SECRET) {
    throw new Error('AUTH_TOKEN_SECRET is required in production');
  }
}

export function getAuthTokenSecret(env = process.env) {
  ensureAuthTokenSecret(env);
  return env.AUTH_TOKEN_SECRET || 'dev-only-auth-token-secret';
}

export function hashAuthToken(raw, env = process.env) {
  if (!raw) return '';
  const secret = getAuthTokenSecret(env);
  return crypto
    .createHmac('sha256', secret)
    .update(String(raw))
    .digest('hex');
}

export function createAuthToken({ bytes = 32, env = process.env } = {}) {
  const raw = crypto.randomBytes(bytes).toString('hex');
  return { raw, hash: hashAuthToken(raw, env) };
}

export function verifyAuthToken(raw, expectedHash, env = process.env) {
  if (!raw || !expectedHash) return false;
  const actual = Buffer.from(hashAuthToken(raw, env));
  const expected = Buffer.from(String(expectedHash));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
