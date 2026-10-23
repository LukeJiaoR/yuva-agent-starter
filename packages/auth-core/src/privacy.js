const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /(^|_)(email|token|secret|password|authorization|cookie|card|cvv|cvc|last4|phone|address|name)($|_)/i;

export function shouldRedactKey(key) {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_');
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

export function redactSensitiveObject(event) {
  if (!event || typeof event !== 'object') return event;
  if (Array.isArray(event)) return event.map(redactSensitiveObject);
  // A sensitive parent owns the entire value, even when providers change its
  // shape from a scalar to an object or array. Never inspect child keys to
  // decide whether the parent's secret may be retained.
  return Object.fromEntries(Object.entries(event).map(([key, value]) => [
    key, shouldRedactKey(key) ? REDACTED : redactSensitiveObject(value),
  ]));
}

export const redactWebhookEvent = redactSensitiveObject;
