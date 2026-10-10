import { describe, expect, it, vi } from 'vitest';
import { createOptionalAuth, createRequireAuth } from '../index.js';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}

for (const [name, factory, optional] of [
  ['required', createRequireAuth, false],
  ['optional', createOptionalAuth, true],
]) {
  describe(`${name} provider-neutral authentication`, () => {
    it('uses a verified subject and tenant context without Clerk settings or SQL', async () => {
      const auth = { kind: 'authenticated', userId: 'subject-1', provider: 'enterprise', tenantId: 'tenant-1' };
      const user = { id: 'local-1' };
      const db = { query: vi.fn() };
      const verifyRequest = vi.fn().mockResolvedValue(auth);
      const findUser = vi.fn().mockResolvedValue(user);
      const tokenVerifier = vi.fn();
      const middleware = factory({ verifyRequest, findUser, db, tokenVerifier, env: { NODE_ENV: 'production' } });
      const req = { headers: {}, body: { userId: 'untrusted-user', tenantId: 'untrusted-tenant' } };
      const res = response(), next = vi.fn();
      await middleware(req, res, next);
      expect(verifyRequest).toHaveBeenCalledExactlyOnceWith(req);
      expect(findUser).toHaveBeenCalledExactlyOnceWith('subject-1', db, auth);
      expect(req.auth).toBe(auth);
      expect(req.clerkAuth).toBeNull();
      expect(req.user).toBe(user);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(tokenVerifier).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('requires an explicit mapping for a custom verifier', () => {
      expect(() => factory({ verifyRequest: vi.fn() })).toThrow(/verifyRequest and findUser/);
      expect(() => factory({ verifyRequest: null, findUser: vi.fn() })).toThrow(/verifyRequest and findUser/);
      expect(() => factory({ verifyRequest: true, findUser: vi.fn() })).toThrow(/verifyRequest and findUser/);
    });

    it.each([
      ['missing', optional ? null : 401, 'authentication_required'],
      ['invalid', 401, 'authentication_required'],
      ['unavailable', 503, 'authentication_unavailable'],
    ])('handles %s without calling the user mapper', async (kind, status, code) => {
      const findUser = vi.fn();
      const middleware = factory({ verifyRequest: async () => ({ kind }), findUser });
      const req = { user: { id: 'stale-user' }, auth: { userId: 'stale-subject' }, clerkAuth: { userId: 'stale-clerk' } };
      const res = response(), next = vi.fn();
      await middleware(req, res, next);
      expect(req).toMatchObject({ user: null, auth: null, clerkAuth: null });
      expect(findUser).not.toHaveBeenCalled();
      if (status) {
        expect(res.status).toHaveBeenCalledWith(status);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
        expect(next).not.toHaveBeenCalled();
      } else {
        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
      }
    });

    it.each([undefined, null, {}, { kind: 'unexpected' }, { kind: 'authenticated' },
      { kind: 'authenticated', userId: '' }, { kind: 'authenticated', userId: '   ' },
      { kind: 'authenticated', userId: 42 }, { kind: 'authenticated', userId: ['subject-1'] },
    ])('fails closed on malformed verifier result %j', async (auth) => {
      const findUser = vi.fn(), next = vi.fn(), res = response();
      await factory({ verifyRequest: async () => auth, findUser })({}, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'authentication_unavailable' }));
      expect(findUser).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('fails closed on a rejected verifier without leaking error details', async () => {
      const findUser = vi.fn(), next = vi.fn(), res = response();
      const middleware = factory({ verifyRequest: async () => { throw new Error('private-verifier-detail'); }, findUser });
      await middleware({}, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('private-verifier-detail');
      expect(findUser).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('keeps missing profiles distinct from rejected authentication', async () => {
      const auth = { kind: 'authenticated', userId: 'subject-1' };
      const res = response(), next = vi.fn(), req = {};
      await factory({ verifyRequest: async () => auth, findUser: async () => null,
        profileRequiredCode: 'setup_required', profileRequiredError: 'Set up your profile' })(req, res, next);
      expect(req.auth).toBe(auth);
      expect(req.user).toBeNull();
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ code: 'setup_required', error: 'Set up your profile' });
    });

    it.each([true, false, 'local-1', [], {}, { id: '' }, { id: '   ' }, { id: 42 }])(
      'fails closed on malformed local profile %j', async (user) => {
        const req = {}, res = response(), next = vi.fn();
        await factory({ verifyRequest: async () => ({ kind: 'authenticated', userId: 'subject-1' }),
          findUser: async () => user })(req, res, next);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'user_profile_unavailable' }));
        expect(req.user).toBeNull();
        expect(next).not.toHaveBeenCalled();
      });

    it('retains legacy Clerk handling when the verified subject has no profile', async () => {
      const req = { headers: { authorization: 'Bearer fixture-token' } }, res = response(), next = vi.fn();
      await factory({ tokenVerifier: async () => ({ sub: 'clerk-1' }), findUser: async () => null,
        env: { NODE_ENV: 'production', CLERK_JWT_KEY: 'fixture-key',
          CLERK_AUTHORIZED_PARTIES: 'https://auth.example.test' } })(req, res, next);
      expect(req.user).toBeNull();
      expect(req.clerkAuth).toMatchObject({ userId: 'clerk-1' });
      if (optional) {
        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
      } else {
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(409);
      }
    });

    it('keeps mapping outages fail-closed with the configured profile error', async () => {
      const next = vi.fn(), res = response();
      await factory({ verifyRequest: async () => ({ kind: 'authenticated', userId: 'subject-1' }),
        findUser: async () => { throw new Error('private-database-detail'); },
        profileUnavailableCode: 'profile_offline', profileUnavailableError: 'Profile unavailable' })({}, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ code: 'profile_offline', error: 'Profile unavailable' });
      expect(next).not.toHaveBeenCalled();
    });

    it('does not misclassify downstream errors as profile outages', async () => {
      const res = response(), error = new Error('downstream-error');
      const middleware = factory({ verifyRequest: async () => ({ kind: 'authenticated', userId: 'subject-1' }),
        findUser: async () => ({ id: 'local-1' }) });
      await expect(middleware({}, res, () => { throw error; })).rejects.toBe(error);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('preserves the default Clerk verifier, SQL mapping, and legacy request field', async () => {
      const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'local-1' }] }) };
      const tokenVerifier = vi.fn().mockResolvedValue({ sub: 'clerk-1', sid: 'session-1' });
      const req = { headers: { authorization: 'Bearer fixture-token' } }, res = response(), next = vi.fn();
      await factory({ db, tokenVerifier, env: { NODE_ENV: 'production', CLERK_JWT_KEY: 'fixture-key',
        CLERK_AUTHORIZED_PARTIES: 'https://auth.example.test' } })(req, res, next);
      expect(tokenVerifier).toHaveBeenCalledExactlyOnceWith('fixture-token', {
        jwtKey: 'fixture-key', authorizedParties: ['https://auth.example.test'],
      });
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("external_auth_provider = 'clerk'"), ['clerk-1']);
      expect(req.clerkAuth).toBe(req.auth);
      expect(req.clerkAuth).toMatchObject({ userId: 'clerk-1', sessionId: 'session-1' });
      expect(req.user).toEqual({ id: 'local-1' });
      expect(next).toHaveBeenCalledOnce();
    });

    it('does not treat a configured tokenVerifier as a replacement for Clerk configuration', async () => {
      const tokenVerifier = vi.fn(), findUser = vi.fn(), res = response(), next = vi.fn();
      await factory({ tokenVerifier, findUser, env: { NODE_ENV: 'production' } })(
        { headers: { authorization: 'Bearer fixture-token' } }, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(tokenVerifier).not.toHaveBeenCalled();
      expect(findUser).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });
}
