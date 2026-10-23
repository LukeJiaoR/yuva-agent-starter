import { describe, expect, it } from 'vitest';
import { redactSensitiveObject, shouldRedactKey } from '../src/privacy.js';
import { createClaimToken, verifyClaimToken } from '../src/claimTokens.js';
const env = { NODE_ENV: 'test', CLAIM_TOKEN_SECRET: 'synthetic-only-regression-key' };

describe('privacy values owned by sensitive parent keys (#89 S08)', () => {
  it.each(['token', 'password', 'accessToken', 'AccessToken', 'APIKeyToken', 'clientSecret', 'cardNumber', 'fullName', 'x-authorization'])('redacts every shape of %s', (key) => {
    for (const value of ['SYNTHETIC', ['SYNTHETIC'], { value: 'SYNTHETIC' }, [{ arbitrary: 'SYNTHETIC' }]]) {
      expect(redactSensitiveObject({ [key]: value })).toEqual({ [key]: '[redacted]' });
    }
  });
  it('preserves safe fields and array shape while redacting nested secrets without mutating input', () => {
    const value = [{ safe: ['ok', { refreshToken: 'SYNTHETIC', count: 2 }] }];
    expect(redactSensitiveObject(value)).toEqual([{ safe: ['ok', { refreshToken: '[redacted]', count: 2 }] }]);
    expect(value[0].safe[1].refreshToken).toBe('SYNTHETIC');
    expect(shouldRedactKey('tokenizer')).toBe(false);
  });
  it('does not assign an input __proto__ property as the output prototype', () => {
    const value = JSON.parse('{"__proto__":{"secret":"SYNTHETIC"},"ok":true}');
    const result = redactSensitiveObject(value);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__.secret).toBe('[redacted]');
  });
});

describe('claim expiry fail-closed (#89 S09)', () => {
  const token = createClaimToken({ env });
  it.each(['invalid-date', new Date(NaN), Infinity, -Infinity, NaN, {}, [], null, undefined, Symbol('invalid'), new Date(0)])('rejects malformed/expired expiry %s', (expiry) => {
    expect(verifyClaimToken(token.raw, token.hash, expiry, env)).toBe(false);
  });
  it('accepts valid future Date, ISO and epoch values, but never a wrong secret', () => {
    for (const expiry of [token.expiresAt, token.expiresAt.toISOString(), token.expiresAt.getTime()]) {
      expect(verifyClaimToken(token.raw, token.hash, expiry, env)).toBe(true);
      expect(verifyClaimToken('wrong', token.hash, expiry, env)).toBe(false);
    }
  });
  it.each([0, -1, NaN, Infinity, '14', Number.MAX_VALUE])('cannot create a token with invalid TTL %s', (ttlDays) => {
    expect(() => createClaimToken({ env, ttlDays })).toThrow();
  });
});
