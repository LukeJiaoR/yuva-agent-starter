import { describe, it, expect, vi } from 'vitest';
import {
  hashAuthToken,
  createAuthToken,
  verifyAuthToken,
  stripSessionToken,
  hardenJsonResponse,
  redactSensitiveObject,
  createClaimToken,
  verifyClaimToken,
  anonymousCookieOptions,
  getClerkAuthorizedParties,
  verifyClerkRequest,
  createRequireAuth,
  createOptionalAuth,
  externalIdentityLockKey,
} from '../index.js';

describe('@yuva/auth-core', () => {
  describe('tokenSecurity', () => {
    it('generates, hashes and verifies auth tokens in constant time', () => {
      const { raw, hash } = createAuthToken();
      expect(raw).toBeDefined();
      expect(hash).toBeDefined();
      expect(verifyAuthToken(raw, hash)).toBe(true);
      expect(verifyAuthToken('wrong-token', hash)).toBe(false);
    });
  });

  describe('responseHardening', () => {
    it('strips session_token from response bodies', () => {
      const body = { session_token: 'secret', user_id: '123', name: 'Alice' };
      const safe = stripSessionToken(body);
      expect(safe.session_token).toBeUndefined();
      expect(safe.user_id).toBe('123');
      expect(safe.name).toBe('Alice');
    });

    it('hardens res.json in place', () => {
      let sentBody = null;
      const res = {
        json: (b) => { sentBody = b; },
      };
      hardenJsonResponse(res);
      res.json({ session_token: 'leak', ok: true });
      expect(sentBody).toEqual({ ok: true });
    });
  });

  describe('privacy', () => {
    it('redacts sensitive keys recursively', () => {
      const payload = {
        email: 'user@example.com',
        auth_token: 'secret123',
        nested: { password: 'pass', safe: 'value' },
        list: [{ card_number: '1234' }],
      };
      const redacted = redactSensitiveObject(payload);
      expect(redacted.email).toBe('[redacted]');
      expect(redacted.auth_token).toBe('[redacted]');
      expect(redacted.nested.password).toBe('[redacted]');
      expect(redacted.nested.safe).toBe('value');
      expect(redacted.list[0].card_number).toBe('[redacted]');
    });
  });

  describe('claimTokens', () => {
    it('creates and verifies claim tokens with TTL and idempotency', () => {
      const { raw, hash, expiresAt } = createClaimToken({ ttlDays: 7, idempotencySeed: 'order-123' });
      expect(verifyClaimToken(raw, hash, expiresAt)).toBe(true);
      expect(verifyClaimToken('tampered', hash, expiresAt)).toBe(false);

      // Expired token fails
      const expiredDate = new Date(Date.now() - 1000);
      expect(verifyClaimToken(raw, hash, expiredDate)).toBe(false);
    });

    it('builds standard anonymous cookie options', () => {
      const opts = anonymousCookieOptions({ nodeEnv: 'production', domain: 'example.com' });
      expect(opts.httpOnly).toBe(true);
      expect(opts.secure).toBe(true);
      expect(opts.sameSite).toBe('lax');
      expect(opts.domain).toBe('example.com');
    });
  });

  describe('clerkAuth', () => {
    it('resolves authorized parties from env', () => {
      const env = {
        CLERK_AUTHORIZED_PARTIES: 'https://app.example.com',
        NODE_ENV: 'production',
      };
      const parties = getClerkAuthorizedParties(env);
      expect(parties).toEqual(['https://app.example.com']);
    });

    it('rejects missing token with kind: missing', async () => {
      const req = { headers: {} };
      const res = await verifyClerkRequest(req, { env: { CLERK_JWT_KEY: 'test-key', FRONTEND_URL: 'http://localhost:3000' } });
      expect(res.kind).toBe('missing');
    });

    it('requires authentication via requireAuth middleware factory', async () => {
      const mockDb = { query: vi.fn() };
      const requireAuth = createRequireAuth({
        db: mockDb,
        profileRequiredError: 'Profile needed',
      });

      const req = { headers: {} };
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      const next = vi.fn();

      await requireAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows anonymous in optionalAuth middleware factory when no token provided', async () => {
      const mockDb = { query: vi.fn() };
      const optionalAuth = createOptionalAuth({ db: mockDb });

      const req = { headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();

      await optionalAuth(req, res, next);
      expect(req.user).toBeNull();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('externalIdentityLock', () => {
    it('generates deterministic lock keys', () => {
      expect(externalIdentityLockKey('clerk', 'user_123')).toBe('external-identity:clerk:user_123');
      expect(externalIdentityLockKey('', '')).toBeNull();
    });
  });
});
