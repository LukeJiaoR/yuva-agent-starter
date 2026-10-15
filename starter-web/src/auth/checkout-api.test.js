import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutRequest } from '../checkout/api.js';

afterEach(() => vi.unstubAllGlobals());
describe('synthetic checkout transport', () => {
  it('sends same-origin credentialed JSON with the exact saved request ID', async () => {
    const body = { productId: 'synthetic-credit-pack-v1', requestId: '180d0c6e-0283-449d-8a46-9dc78182e33e' };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mock: true, status: 'pending' })));
    vi.stubGlobal('fetch', fetch);
    await checkoutRequest('/orders', { body });
    expect(fetch).toHaveBeenCalledWith('/api/mock-checkout/orders', expect.objectContaining({
      method: 'POST', credentials: 'include', cache: 'no-store', body: JSON.stringify(body),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    }));
  });
  it('supports feature-off non-JSON 404 and hides backend text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private server text', { status: 404 })));
    await expect(checkoutRequest('/products')).rejects.toMatchObject({ status: 404, message: 'Demo order request could not be confirmed.' });
  });
  it('preserves ambiguity as an error without attempting another request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'checkout_outcome_unknown' }), { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(checkoutRequest('/orders', { body: {} })).rejects.toMatchObject({ status: 503, code: 'checkout_outcome_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails closed for a non-demo success response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'paid' }))));
    await expect(checkoutRequest('/orders')).rejects.toThrow();
  });
});
