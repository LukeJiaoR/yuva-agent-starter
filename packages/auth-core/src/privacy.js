const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /(^|_)(email|token|secret|password|authorization|cookie|card|cvv|cvc|last4|phone|address|name)($|_)/i;

export function shouldRedactKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key || ''));
}

export function redactSensitiveObject(event) {
  if (!event || typeof event !== 'object') return event;
  const redacted = {};

  for (const [key, value] of Object.entries(event)) {
    if (shouldRedactKey(key)) {
      redacted[key] = redactValue(value);
    } else if (Array.isArray(value)) {
      redacted[key] = value.map((item) => redactSensitiveObject(item));
    } else if (value && typeof value === 'object') {
      redacted[key] = redactSensitiveObject(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveObject(item));
  if (value && typeof value === 'object') return redactSensitiveObject(value);
  return REDACTED;
}

export const redactWebhookEvent = redactSensitiveObject;
