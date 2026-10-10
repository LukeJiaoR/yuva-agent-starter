import { createHmac } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getClaimSecret, hashSecret, createClaimToken, verifyClaimToken } from '../index.js';

const future = () => new Date(Date.now() + 60_000);

describe('production claim secret configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  const missingConfigurations = [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', CLAIM_TOKEN_SECRET: '', UNSUBSCRIBE_SECRET: '' },
  ];
  for (const env of missingConfigurations) {
    const operations = {
      resolve: () => getClaimSecret(env),
      hash: () => hashSecret('private-claim-fixture', env),
      randomIssue: () => createClaimToken({ env }),
      deterministicIssue: () => createClaimToken({ env, idempotencySeed: 'private-order-fixture' }),
      verify: () => verifyClaimToken('private-claim-fixture', 'private-hash-fixture', future(), env),
    };
    it.each(Object.entries(operations))(`rejects %s when production secrets are absent (${Object.keys(env).length} keys)`, (_name, operation) => {
      expect(operation).toThrow('CLAIM_TOKEN_SECRET or UNSUBSCRIBE_SECRET is required in production');
    });
  }

  it.each(['CLAIM_TOKEN_SECRET', 'UNSUBSCRIBE_SECRET'])('preserves existing %s key bytes and token signatures', (name) => {
    // Deliberate surrounding spaces protect existing key bytes against normalization.
    const secret = '  synthetic-legacy-claim-key  ';
    const env = { NODE_ENV: 'production', [name]: secret };
    const raw = createHmac('sha256', secret).update('claim-token:v1:order-fixture').digest('base64url');
    const hash = createHmac('sha256', secret).update(raw).digest('hex');
    expect(getClaimSecret(env)).toBe(secret);
    expect(createClaimToken({ env, idempotencySeed: 'order-fixture' })).toMatchObject({ raw, hash });
    expect(hashSecret(raw, env)).toBe(hash);
    expect(verifyClaimToken(raw, hash, future(), env)).toBe(true);
    const random = createClaimToken({ env });
    expect(Buffer.from(random.raw, 'base64url')).toHaveLength(32);
    expect(verifyClaimToken(random.raw, random.hash, random.expiresAt, env)).toBe(true);
  });

  it('retains dedicated-key priority and empty dedicated-key fallback', () => {
    expect(getClaimSecret({ NODE_ENV: 'production', CLAIM_TOKEN_SECRET: 'dedicated-fixture', UNSUBSCRIBE_SECRET: 'legacy-fixture' })).toBe('dedicated-fixture');
    expect(getClaimSecret({ NODE_ENV: 'production', CLAIM_TOKEN_SECRET: '', UNSUBSCRIBE_SECRET: 'legacy-fixture' })).toBe('legacy-fixture');
  });

  it.each(['development', 'test', undefined])('retains the development fallback in %s', (NODE_ENV) => {
    const env = { NODE_ENV };
    expect(getClaimSecret(env)).toBe('dev-only-claim-secret');
    const claim = createClaimToken({ env });
    expect(verifyClaimToken(claim.raw, claim.hash, claim.expiresAt, env)).toBe(true);
  });

  it('keeps missing and expired token verification false without hashing', () => {
    const env = { NODE_ENV: 'production' };
    expect(verifyClaimToken('', null, null, env)).toBe(false);
    expect(verifyClaimToken('fixture', 'hash', new Date(0), env)).toBe(false);
  });

  it('guards the default process environment and rejects development-fallback signatures in production', () => {
    const claim = createClaimToken({ env: { NODE_ENV: 'test' }, idempotencySeed: 'development-only-fixture' });
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CLAIM_TOKEN_SECRET', undefined);
    vi.stubEnv('UNSUBSCRIBE_SECRET', undefined);
    for (const operation of [
      () => getClaimSecret(),
      () => hashSecret(claim.raw),
      () => createClaimToken(),
      () => verifyClaimToken(claim.raw, claim.hash, claim.expiresAt),
    ]) {
      expect(operation).toThrow('CLAIM_TOKEN_SECRET or UNSUBSCRIBE_SECRET is required in production');
    }
  });
});
