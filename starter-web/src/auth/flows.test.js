import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileRevokedSession, resetPasswordAndRefresh, signInWithProfile } from './flows.js';

afterEach(() => vi.unstubAllGlobals());
const success = () => new Response('{"status":true}', { status: 200 });

describe('account state reconciliation', () => {
  it('provisions after sign-in, then refreshes the application account before completing', async () => {
    const order = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => { order.push(url); return success(); }));
    const refresh = vi.fn(async () => { order.push('refresh'); return { user: { id: 'u1' } }; });
    await signInWithProfile({ email: 'test@example.com', password: 'synthetic-password' }, refresh);
    expect(order).toEqual(['/api/auth/sign-in/email', '/api/auth/provision', 'refresh']);
  });

  it('reconciles a signed-in auth account even when legacy provisioning refuses its identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(success()).mockResolvedValueOnce(new Response('{"code":"identity_conflict"}', { status: 409 })));
    const refresh = vi.fn().mockResolvedValue({ user: { id: 'u1' }, profile: null });
    await expect(signInWithProfile({ email: 'test@example.com', password: 'synthetic-password' }, refresh)).rejects.toMatchObject({ code: 'identity_conflict' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not provision or refresh after a dismissed sign-in returns late', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return success(); }));
    const refresh = vi.fn();
    await expect(signInWithProfile({ email: 'test@example.com', password: 'synthetic-password' }, refresh, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes revoked identity after password reset before completing', async () => {
    const order = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => { order.push(url); return success(); }));
    const refresh = vi.fn(async () => { order.push('refresh'); return { user: null }; });
    await resetPasswordAndRefresh({ token: 'synthetic-token', newPassword: 'synthetic-password' }, refresh);
    expect(order).toEqual(['/api/auth/reset-password', 'refresh']);
  });

  it('does not misreport a completed reset as failed when subsequent session refresh is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success()));
    const refresh = vi.fn().mockRejectedValue(Object.assign(new Error('Unavailable'), { status: 503 }));
    await expect(resetPasswordAndRefresh({ token: 'synthetic-token', newPassword: 'synthetic-password' }, refresh)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves cancellation during the post-reset session refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success()));
    const refresh = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(resetPasswordAndRefresh({ token: 'synthetic-token', newPassword: 'synthetic-password' }, refresh)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('clears revoked session state after a sessions 401, but does not sign out a merely stale session', async () => {
    const refresh = vi.fn().mockResolvedValue({ user: null });
    await reconcileRevokedSession({ status: 401 }, refresh);
    expect(refresh).toHaveBeenCalledOnce();
    await reconcileRevokedSession({ status: 403, code: 'session_not_fresh' }, refresh);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
