// Store only a non-secret operation ID and product ID, scoped to the signed-in
// product identity. Persist BEFORE sending so a reload cannot invent a retry.
export function intentKey(identity) { return `starter-demo-checkout:v1:${identity}`; }
export function readIntent(storage, identity) {
  const raw = storage.getItem(intentKey(identity));
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value.productId !== 'string' || value.productId.length < 1 || value.productId.length > 128 || typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.requestId)) {
    throw new Error('Saved demo request is unreadable.');
  }
  return { productId: value.productId, requestId: value.requestId };
}
export function saveIntent(storage, identity, intent) {
  storage.setItem(intentKey(identity), JSON.stringify(intent));
  const saved = readIntent(storage, identity);
  if (saved?.requestId !== intent.requestId || saved?.productId !== intent.productId) throw new Error('Demo request could not be saved.');
  return saved;
}
export function displayPrice(product) {
  if (!Number.isSafeInteger(product?.amountMinor) || product.amountMinor < 0 || !/^[A-Z]{3}$/u.test(product.currency)) return 'Illustrative price unavailable';
  return `${(product.amountMinor / 100).toFixed(2)} ${product.currency}`;
}
