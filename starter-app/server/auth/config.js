const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
export function authMode(env) {
  const mode = env.AUTH_MODE || 'clerk';
  if (!['clerk', 'self-hosted'].includes(mode)) throw new Error('AUTH_MODE must be clerk or self-hosted');
  return mode;
}
function origin(value, label, production) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an explicit origin`); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
    || !['https:', 'http:'].includes(parsed.protocol)
    || (parsed.protocol !== 'https:' && (production || !loopback.has(parsed.hostname)))) {
    throw new Error(`${label} must be HTTPS (HTTP loopback is allowed only in development)`);
  }
  return parsed.origin;
}
export function readSelfHostedConfig(env) {
  const production = env.NODE_ENV === 'production';
  const secret = String(env.BETTER_AUTH_SECRET || '');
  if (secret.length < 32 || /development_auth|changeme|example|replace[_-]?me/iu.test(secret)) {
    throw new Error('Self-hosted auth requires a private BETTER_AUTH_SECRET of at least 32 characters');
  }
  const baseURL = origin(env.BETTER_AUTH_URL, 'BETTER_AUTH_URL', production);
  const frontendURL = origin(env.FRONTEND_URL, 'FRONTEND_URL', production);
  // A host-only Lax cookie is intentionally a same-origin deployment contract.
  // Vite's /api proxy provides the same contract in development.
  if (baseURL !== frontendURL) throw new Error('Self-hosted auth requires BETTER_AUTH_URL and FRONTEND_URL to share one origin');
  const trustedOrigins = String(env.AUTH_TRUSTED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean)
    .map((v) => origin(v, 'AUTH_TRUSTED_ORIGINS', production));
  if (!trustedOrigins.length || !trustedOrigins.includes(baseURL)) throw new Error('AUTH_TRUSTED_ORIGINS must explicitly include the application origin');
  const mailMode = env.AUTH_MAIL_MODE || '';
  if (!['capture', 'smtp', 'custom'].includes(mailMode)) throw new Error('Set AUTH_MAIL_MODE to capture, smtp, or custom');
  if (mailMode === 'capture' && (production || !loopback.has(new URL(baseURL).hostname))) {
    throw new Error('Development mail capture requires a loopback application origin and non-production mode');
  }
  if (mailMode === 'smtp') {
    if (!env.AUTH_SMTP_HOST || !env.AUTH_SMTP_USER || !env.AUTH_SMTP_PASSWORD || !env.AUTH_MAIL_FROM) throw new Error('SMTP auth mail requires AUTH_SMTP_HOST, AUTH_SMTP_USER, AUTH_SMTP_PASSWORD, and AUTH_MAIL_FROM');
    if (![465, 587].includes(Number(env.AUTH_SMTP_PORT || 465))) throw new Error('AUTH_SMTP_PORT must be 465 or 587');
  }
  const signupCredits = Number(env.AUTH_SIGNUP_CREDITS ?? 25);
  if (!Number.isSafeInteger(signupCredits) || signupCredits < 0 || signupCredits > 100000) throw new Error('AUTH_SIGNUP_CREDITS must be an integer from 0 to 100000');
  return Object.freeze({ production, secret, baseURL, frontendURL, trustedOrigins, mailMode, signupCredits });
}
