import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server/index.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function serve(options) {
  const app = createServer(options);
  app.get('/auth-fixture', (req, res) => res.json({ userId: req.user?.id ?? null, clerk: req.clerkAuth !== null }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const config = { env: { NODE_ENV: 'test', ALLOW_DEV_GUEST: 'true', AI_PROVIDER: 'mock' } };

describe('server-owned authentication composition', () => {
  it('accepts a separately verified enterprise subject without Clerk secrets or the default users table', async () => {
    const db = { query: vi.fn() };
    const auth = { kind: 'authenticated', userId: 'enterprise-subject', tenantId: 'verified-tenant' };
    const findUser = vi.fn().mockResolvedValue({ id: 'local-account' });
    const verifyRequest = vi.fn(async (req) => req.headers.authorization === 'Bearer fixture-session'
      ? auth : { kind: 'invalid' });
    const url = await serve({ db, config, auth: { verifyRequest, findUser } });
    const result = await fetch(`${url}/auth-fixture`, {
      headers: { authorization: 'Bearer fixture-session', 'x-user-id': 'forged-user', 'x-tenant-id': 'forged-tenant' },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ userId: 'local-account', clerk: false });
    expect(findUser).toHaveBeenCalledExactlyOnceWith('enterprise-subject', db, auth);
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 401, 'authentication_required'],
    ['unavailable', 503, 'authentication_unavailable'],
    ['unknown', 503, 'authentication_unavailable'],
  ])('never falls back to development guest access for %s credentials', async (kind, status, code) => {
    const findUser = vi.fn(), db = { query: vi.fn() }, callAIStream = vi.fn();
    const url = await serve({ db, config, callAIStream, auth: { verifyRequest: async () => ({ kind }), findUser } });
    const result = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Fixture' }),
    });
    expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({ code });
    expect(findUser).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(callAIStream).not.toHaveBeenCalled();
  });

  it.each([
    [null, 409, 'user_profile_required'],
    [undefined, 409, 'user_profile_required'],
    [{}, 503, 'user_profile_unavailable'],
    [{ id: '' }, 503, 'user_profile_unavailable'],
    [{ id: 42 }, 503, 'user_profile_unavailable'],
    [true, 503, 'user_profile_unavailable'],
  ])('does not use the guest account when a verified subject maps to %j', async (user, status, code) => {
    const db = { query: vi.fn() }, callAIStream = vi.fn();
    const url = await serve({ db, config, callAIStream, auth: {
      verifyRequest: async () => ({ kind: 'authenticated', userId: 'enterprise-subject' }),
      findUser: async () => user,
    } });
    const result = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Fixture' }),
    });
    expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({ code });
    expect(db.query).not.toHaveBeenCalled();
    expect(callAIStream).not.toHaveBeenCalled();
  });

  it('keeps anonymous requests optional only when the verifier explicitly reports missing credentials', async () => {
    const findUser = vi.fn();
    const url = await serve({ db: {}, config, auth: { verifyRequest: async () => ({ kind: 'missing' }), findUser } });
    const result = await fetch(`${url}/auth-fixture`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ userId: null, clerk: false });
    expect(findUser).not.toHaveBeenCalled();
  });

  it('rejects a custom verifier without an explicit product mapping at startup', () => {
    expect(() => createServer({ db: {}, config, auth: { verifyRequest: vi.fn() } })).toThrow(/findUser/);
  });
});
