import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenVerificationErrorReason as Reason } from '@clerk/backend/errors';
import { verifyClerkRequest } from '../index.js';

const request = { headers: { authorization: 'Bearer fixture-token' } };
const env = { NODE_ENV: 'production', CLERK_JWT_KEY: 'fixture-key',
  CLERK_AUTHORIZED_PARTIES: 'https://auth.example.test' };
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('lazily loaded Clerk verification compatibility', () => {
  it('uses the installed SDK by default and rejects malformed JWTs without network access', async () => {
    const fetch = vi.fn(() => { throw new Error('Network is forbidden in this fixture'); });
    vi.stubGlobal('fetch', fetch);
    expect(await verifyClerkRequest(request, { env })).toEqual({ kind: 'invalid', token: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([Reason.TokenVerificationFailed, Reason.TokenExpired, Reason.TokenInvalid,
    Reason.TokenInvalidAlgorithm, Reason.TokenInvalidAuthorizedParties, Reason.TokenInvalidSignature,
    Reason.TokenNotActiveYet, Reason.TokenIatInTheFuture])('keeps reason %s invalid for thrown and envelope errors', async (reason) => {
    const error = Object.assign(new Error('Fixture invalid credential'), { reason });
    for (const tokenVerifier of [async () => { throw error; }, async () => ({ data: null, errors: [error] })]) {
      expect(await verifyClerkRequest(request, { env, tokenVerifier })).toEqual({ kind: 'invalid', token: null });
    }
  });

  it('keeps unknown errors unavailable for thrown and envelope errors', async () => {
    const error = Object.assign(new Error('Fixture infrastructure outage'), { reason: 'fixture-unavailable' });
    for (const tokenVerifier of [async () => { throw error; }, async () => ({ errors: [error] })]) {
      expect(await verifyClerkRequest(request, { env, tokenVerifier })).toEqual({ kind: 'unavailable', token: null });
    }
  });

  it.each(['throw', 'envelope'])('preserves the signature-only JWKS fallback after %s', async (mode) => {
    const error = Object.assign(new Error('Fixture signature mismatch'), { reason: Reason.TokenInvalidSignature });
    const tokenVerifier = vi.fn()
      .mockImplementationOnce(async () => { if (mode === 'throw') throw error; return { errors: [error] }; })
      .mockResolvedValueOnce({ data: { sub: 'subject-1', sid: 'session-1' }, errors: null });
    const result = await verifyClerkRequest(request, { env: { ...env, CLERK_SECRET_KEY: 'fixture-secret' }, tokenVerifier });
    expect(result).toMatchObject({ kind: 'authenticated', userId: 'subject-1', sessionId: 'session-1' });
    expect(tokenVerifier.mock.calls).toEqual([
      ['fixture-token', { jwtKey: 'fixture-key', authorizedParties: ['https://auth.example.test'] }],
      ['fixture-token', { secretKey: 'fixture-secret', authorizedParties: ['https://auth.example.test'] }],
    ]);
  });

  it('does not retry expired credentials with the secret key', async () => {
    const tokenVerifier = vi.fn().mockRejectedValue({ reason: Reason.TokenExpired });
    expect(await verifyClerkRequest(request, { env: { ...env, CLERK_SECRET_KEY: 'fixture-secret' }, tokenVerifier }))
      .toEqual({ kind: 'invalid', token: null });
    expect(tokenVerifier).toHaveBeenCalledOnce();
  });

  it('supports secret-only configuration and direct claims', async () => {
    const tokenVerifier = vi.fn().mockResolvedValue({ sub: 'subject-1' });
    expect(await verifyClerkRequest(request, { env: { ...env, CLERK_JWT_KEY: '', CLERK_SECRET_KEY: 'fixture-secret' }, tokenVerifier }))
      .toMatchObject({ kind: 'authenticated', userId: 'subject-1', sessionId: null });
    expect(tokenVerifier).toHaveBeenCalledExactlyOnceWith('fixture-token', {
      secretKey: 'fixture-secret', authorizedParties: ['https://auth.example.test'],
    });
  });
});
