import { describe, expect, it } from 'vitest';
import { displayPrice, intentKey, readIntent, saveIntent } from '../checkout/state.js';

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const intent = { productId: 'synthetic-credit-pack-v1', requestId: '180d0c6e-0283-449d-8a46-9dc78182e33e' };

describe('synthetic checkout retry persistence', () => {
  it('keeps the exact request across reload and isolates account identities', () => {
    const store = storage();
    expect(saveIntent(store, 'self-hosted:profile:alice', intent)).toEqual(intent);
    expect(readIntent(store, 'self-hosted:profile:alice')).toEqual(intent);
    expect(readIntent(store, 'self-hosted:profile:bob')).toBeNull();
  });
  it('does not accept corrupt request IDs or silently invent a replacement', () => {
    const store = storage();
    store.setItem(intentKey('alice'), JSON.stringify({ ...intent, requestId: 'invalid' }));
    expect(() => readIntent(store, 'alice')).toThrow();
  });
  it('fails closed when browser storage cannot persist intent', () => {
    expect(() => saveIntent({ setItem() { throw new Error('blocked'); } }, 'alice', intent)).toThrow();
  });
  it('reads only operation metadata from storage', () => {
    const store = storage();
    store.setItem(intentKey('alice'), JSON.stringify({ ...intent, secret: 'never-use' }));
    expect(readIntent(store, 'alice')).toEqual(intent);
  });
  it('displays server price metadata and rejects invalid values', () => {
    expect(displayPrice({ amountMinor: 100, currency: 'USD' })).toBe('1.00 USD');
    expect(displayPrice({ amountMinor: -1, currency: 'USD' })).toBe('Illustrative price unavailable');
  });
});
