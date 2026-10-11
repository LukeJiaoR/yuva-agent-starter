import { afterEach, describe, expect, it, vi } from 'vitest';
import { authRequest } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('same-origin auth transport', () => {
  it('sends cookie credentials and JSON bodies without placing credentials in URLs', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(authRequest('/reset-password', { body: { token: 'synthetic-token', newPassword: 'synthetic-password' }, signal: controller.signal })).resolves.toEqual({ status: true });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/reset-password');
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
    expect(JSON.parse(options.body)).toEqual({ token: 'synthetic-token', newPassword: 'synthetic-password' });
  });

  it('uses a credentialed read with the explicit development-inbox header', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"messages":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await authRequest('/dev/mail', { headers: { 'X-Starter-Dev-Inbox': '1' } });
    expect(fetch.mock.calls[0]).toEqual(['/api/auth/dev/mail', expect.objectContaining({ method: 'GET', credentials: 'include', headers: { Accept: 'application/json', 'X-Starter-Dev-Inbox': '1' } })]);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('retains safe application status and code but omits provider messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"code":"identity_conflict","message":"private provider payload"}', { status: 409 })));
    await expect(authRequest('/provision', { body: {} })).rejects.toMatchObject({ status: 409, code: 'identity_conflict', message: 'Account request failed.' });
  });

  it('propagates an abort so canceled work cannot report success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    await expect(authRequest('/sign-in/email', { body: {} })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
