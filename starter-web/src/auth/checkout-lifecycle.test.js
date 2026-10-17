// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from './useAuth.js';
import { DemoCheckout } from '../checkout/DemoCheckout.jsx';
import { checkoutRequest } from '../checkout/api.js';
import { readIntent } from '../checkout/state.js';

vi.mock('../checkout/api.js', () => ({ checkoutRequest: vi.fn() }));
const product = { id: 'synthetic-credit-pack-v1', label: 'Synthetic pack', amountMinor: 100, currency: 'USD', credits: 10, synthetic: true };
let root, container, locks;
function account(id) {
  return { enabled: true, sessionStatus: 'authenticated', session: { profile: { id }, user: { id } }, refreshSession: vi.fn().mockResolvedValue({}) };
}
async function render(id) {
  await act(async () => root.render(React.createElement(AuthContext.Provider, { value: account(id) }, React.createElement(DemoCheckout))));
}
async function click(text) {
  await act(async () => {
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === text);
    if (!button) throw new Error(`Button not found: ${text}`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
function order(body, label = product.label) {
  return { mock: true, ...body, orderId: 'order-1', status: 'pending', product: { ...product, label }, createdAt: '2026-10-15', creditsGranted: 0 };
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  locks = vi.fn(async (_key, _options, callback) => callback());
  vi.stubGlobal('navigator', { locks: { request: locks } });
  checkoutRequest.mockReset();
  checkoutRequest.mockImplementation(async (path) => {
    if (path === '/products') return { mock: true, products: [product] };
    if (path.startsWith('/orders?')) return { mock: true, orders: [] };
    throw new Error('Unexpected request');
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.unstubAllGlobals(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('mounted demo order recovery', () => {
  it('persists before POST and retries the exact intent after ambiguous response and remount', async () => {
    const bodies = [];
    const reads = checkoutRequest.getMockImplementation();
    checkoutRequest.mockImplementation(async (path, options) => {
      if (path !== '/orders') return reads(path, options);
      bodies.push(options.body);
      expect(readIntent(localStorage, 'self-hosted:profile:A')).toEqual(options.body);
      if (bodies.length === 1) throw new Error('Lost acknowledgment');
      return order(options.body);
    });
    await render('A'); await click('Create demo order');
    await act(async () => root.render(null));
    await render('A'); await click('Check saved request');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(locks.mock.calls[0][0]).toBe('starter-demo-checkout:v1:self-hosted:profile:A');
  });
  it('aborts account A work and ignores its late completion after switching to B', async () => {
    let resolve, submitted;
    const pending = new Promise((done) => { resolve = done; });
    const reads = checkoutRequest.getMockImplementation();
    checkoutRequest.mockImplementation((path, options) => {
      if (path !== '/orders') return reads(path, options);
      submitted = options;
      return pending;
    });
    await render('A'); await click('Create demo order'); await render('B');
    expect(submitted.signal.aborted).toBe(true);
    await act(async () => resolve(order(submitted.body, 'Private A order')));
    expect(container.textContent).not.toContain('Private A order');
    expect(container.textContent).not.toContain('Check saved request');
    expect(readIntent(localStorage, 'self-hosted:profile:B')).toBeNull();
    expect(readIntent(localStorage, 'self-hosted:profile:A')).toEqual(submitted.body);
  });
  it('fails closed without cross-tab locks and never sends an order POST', async () => {
    vi.stubGlobal('navigator', {});
    await render('A'); await click('Create demo order');
    expect(container.textContent).toContain('cannot safely coordinate');
    expect(checkoutRequest.mock.calls.some(([path]) => path === '/orders')).toBe(false);
  });
  it('renders disabled state on the feature-off response', async () => {
    checkoutRequest.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    await render('A');
    expect(container.textContent).toContain('Demo checkout is disabled');
    expect(container.textContent).toContain('No money is collected');
    expect(container.textContent).not.toContain('Create demo order');
  });
});
