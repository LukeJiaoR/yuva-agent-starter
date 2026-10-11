import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { betterAuth, APIError } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { readSelfHostedConfig } from './config.js';
import { createAuthMail } from './mail.js';
import { findSelfHostedUser, provisionSelfHostedUser, SELF_HOSTED_AUTHORITY } from './identity.js';

const fields = {
  createdAt: 'created_at', updatedAt: 'updated_at', userId: 'user_id',
};
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const errors = {
  INVALID_EMAIL_OR_PASSWORD: 'Email or password is incorrect.',
  EMAIL_NOT_VERIFIED: 'Verify your email before signing in.',
  PASSWORD_TOO_SHORT: 'Use a password with at least 12 characters.',
  PASSWORD_TOO_LONG: 'Use a password with no more than 128 characters.',
  INVALID_TOKEN: 'This link is invalid, expired, or already used. Request a new one.',
  TOKEN_EXPIRED: 'This link has expired. Request a new one.',
  INVALID_EMAIL: 'Enter a valid email address.',
};
function publicError(res, status, code, message) {
  return res.status(status).json({ code, error: code, message });
}
function sessionView(value) {
  return value ? { id: value.id, createdAt: value.createdAt, expiresAt: value.expiresAt, userAgent: value.userAgent || '' } : null;
}
function userView(value) { return { id: value.id, email: value.email, name: value.name, emailVerified: value.emailVerified }; }
function authCookie(req) {
  return /(?:^|;\s*)(?:__Secure-)?starter-auth\.session_token=/u.test(req.headers.cookie || '');
}
function trustedWrite(req, config) {
  return config.trustedOrigins.includes(req.headers.origin)
    && req.headers['sec-fetch-site'] !== 'cross-site';
}
export function createSelfHostedAuth({ db, env, sendMail }) {
  const config = readSelfHostedConfig(env);
  const mail = createAuthMail({ config, env, sendMail });
  const pendingMail = new Set();
  let mailFailed = false;
  const signInContext = new AsyncLocalStorage();
  async function sendAuthMessage(message) {
    try { await mail.send(message); mailFailed = false; }
    catch (error) {
      mailFailed = true;
      console.error('[Auth mail] Delivery failed; no message content logged.');
      throw error;
    }
  }
  const auth = betterAuth({
    appName: 'Starter', baseURL: config.baseURL, basePath: '/api/auth', secret: config.secret,
    database: db, trustedOrigins: config.trustedOrigins, telemetry: { enabled: false },
    // Never log upstream error payloads, request bodies, passwords or tokens.
    logger: { disabled: true }, onAPIError: { throw: true },
    user: { modelName: 'auth_users', fields: { name: 'name', email: 'email', emailVerified: 'email_verified', image: 'image', createdAt: fields.createdAt, updatedAt: fields.updatedAt },
      additionalFields: { disabled: { type: 'boolean', defaultValue: false, input: false, returned: false } } },
    session: { modelName: 'auth_sessions', fields: { ...fields, expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent' },
      expiresIn: 7 * 24 * 3600, freshAge: 300, disableSessionRefresh: true, cookieCache: { enabled: false },
      additionalFields: { credentialVersion: { type: 'number', fieldName: 'credential_version', defaultValue: 0, input: false, returned: false } } },
    account: { modelName: 'auth_accounts', fields: { ...fields, accountId: 'account_id', providerId: 'provider_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at' },
      accountLinking: { enabled: false, disableImplicitLinking: true }, encryptOAuthTokens: true },
    verification: { modelName: 'auth_verifications', fields: { createdAt: fields.createdAt, updatedAt: fields.updatedAt, expiresAt: 'expires_at' }, storeIdentifier: 'hashed' },
    rateLimit: { enabled: true, storage: 'database', modelName: 'auth_rate_limits', fields: { lastRequest: 'last_request' }, window: 60, max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 }, '/request-password-reset': { window: 60, max: 5 }, '/send-verification-email': { window: 60, max: 5 }, '/reset-password': { window: 60, max: 5 } } },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128,
      requireEmailVerification: true, autoSignIn: false, resetPasswordTokenExpiresIn: 900, revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) => sendAuthMessage({ user, token, type: 'reset' }) },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false, expiresIn: 900,
      sendVerificationEmail: ({ user, token }) => sendAuthMessage({ user, token, type: 'verify' }) },
    advanced: { database: { generateId: 'uuid' }, useSecureCookies: config.production || config.baseURL.startsWith('https:'),
      cookiePrefix: 'starter-auth', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      crossSubDomainCookies: { enabled: false }, ipAddress: { ipAddressHeaders: ['x-starter-auth-ip'] },
      backgroundTasks: { handler(promise) {
        pendingMail.add(promise);
        promise.catch(() => {})
          .finally(() => pendingMail.delete(promise));
      } } },
    databaseHooks: { session: { create: { async before(session) {
      const { rows: [user] } = await db.query('SELECT disabled,email_verified FROM auth_users WHERE id=$1', [session.userId]);
      const snapshot = signInContext.getStore();
      if (!user || user.disabled || !user.email_verified || snapshot?.userId !== session.userId) throw new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: errors.INVALID_EMAIL_OR_PASSWORD });
      return { data: { ...session, credentialVersion: snapshot.credentialVersion } };
    } } } },
  });
  async function readSession(req) {
    if (req.headers.authorization) return { kind: 'invalid' }; // Explicit mode, no silent provider fallback.
    if (!authCookie(req)) return { kind: 'missing' };
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableCookieCache: true, disableRefresh: true } });
    if (!session) return { kind: 'invalid' };
    const { rows: [user] } = await db.query('SELECT disabled,email_verified FROM auth_users WHERE id=$1', [session.user.id]);
    if (!user || user.disabled || !user.email_verified) return { kind: 'invalid' };
    return { kind: 'authenticated', userId: session.user.id, authority: SELF_HOSTED_AUTHORITY, session };
  }
  async function requireSession(req, res) {
    const identity = await readSession(req);
    if (identity.kind !== 'authenticated') { publicError(res, 401, 'authentication_required', 'Sign in to continue.'); return null; }
    return identity;
  }
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
    if (req.originalUrl.includes('?')) return publicError(res, 400, 'invalid_request', 'Authentication parameters must not be placed in URLs.');
    if (!['GET', 'HEAD'].includes(req.method) && !trustedWrite(req, config)) return publicError(res, 403, 'invalid_origin', 'Request origin is not allowed.');
    if (req.method === 'POST' && !req.is('application/json')) return publicError(res, 415, 'invalid_request', 'Use application/json.');
    return next();
  });
  // Mount before the application JSON parser. Limit raw bytes before constructing
  // an upstream Request, rather than reading an unlimited body into memory.
  router.use(express.raw({ type: 'application/json', limit: '16kb' }));
  router.use(async (req, res) => {
    let snapshot;
    try {
      const path = req.path;
      if (req.method === 'GET' && path === '/config') return res.json({ mode: 'self-hosted', enabled: true, capture: config.mailMode === 'capture' });
      if (req.method === 'GET' && path === '/dev/mail') {
        if (config.mailMode !== 'capture' || !loopback.has(req.socket.remoteAddress)
          || req.headers['x-starter-dev-inbox'] !== '1'
          || req.headers.host !== new URL(config.baseURL).host
          || req.headers['x-forwarded-host'] || req.headers['x-forwarded-for'] || req.headers['forwarded']
          || !(trustedWrite(req, config) || (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin'))) return res.sendStatus(404);
        return res.json({ messages: mail.list() });
      }
      let body = {};
      if (req.method === 'POST') {
        try { body = JSON.parse(req.body?.toString('utf8') || '{}'); } catch { return publicError(res, 400, 'invalid_request', 'Invalid JSON.'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return publicError(res, 400, 'invalid_request', 'Invalid request.');
      }
      if (req.method === 'GET' && path === '/get-session') {
        const identity = await readSession(req);
        if (identity.kind === 'invalid') return publicError(res, 401, 'authentication_required', 'Your session has expired. Sign in again.');
        if (identity.kind === 'missing') return res.json({ user: null, session: null, profile: null });
        return res.json({ user: userView(identity.session.user), session: sessionView(identity.session.session), profile: await findSelfHostedUser(identity.userId, db) });
      }
      if ((req.method === 'POST' && ['/provision', '/revoke-session', '/revoke-other-sessions'].includes(path)) || (req.method === 'GET' && path === '/sessions')) {
        const identity = await requireSession(req, res); if (!identity) return;
        if (path === '/provision') return res.json({ profile: await provisionSelfHostedUser({ db, subject: identity.userId, signupCredits: config.signupCredits }) });
        if (path === '/sessions') {
          const { rows } = await db.query(`SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",user_agent AS "userAgent" FROM auth_sessions WHERE user_id=$1 AND expires_at>NOW() ORDER BY created_at DESC`, [identity.userId]);
          return res.json({ sessions: rows.map((session) => ({ ...sessionView(session), current: session.id === identity.session.session.id })) });
        }
        if (Date.now() - new Date(identity.session.session.createdAt).getTime() > 300000) return publicError(res, 403, 'session_not_fresh', 'Sign in again before managing other sessions.');
        if (path === '/revoke-session') {
          if (typeof body.sessionId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(body.sessionId)) return publicError(res, 400, 'invalid_request', 'Choose a valid session.');
          await db.query('DELETE FROM auth_sessions WHERE user_id=$1 AND id=$2', [identity.userId, body.sessionId]);
        } else await db.query('DELETE FROM auth_sessions WHERE user_id=$1 AND id<>$2', [identity.userId, identity.session.session.id]);
        return res.json({ status: true });
      }
      const publicPaths = { '/sign-up/email': ['name', 'email', 'password'], '/sign-in/email': ['email', 'password'], '/sign-out': [],
        '/request-password-reset': ['email'], '/send-verification-email': ['email'], '/reset-password': ['token', 'newPassword'], '/verify-email': ['token'] };
      if (req.method !== 'POST' || !Object.hasOwn(publicPaths, path)) return res.sendStatus(404);
      const input = {};
      for (const key of publicPaths[path]) {
        if (typeof body[key] !== 'string') return publicError(res, 400, 'invalid_request', `Missing ${key === 'token' ? 'link' : key}.`);
        input[key] = body[key];
      }
      if (input.email) input.email = input.email.trim().toLowerCase();
      if (input.name) input.name = input.name.trim().slice(0, 100);
      if (input.token && input.token.length > 2048) return publicError(res, 400, 'invalid_request', 'Invalid link.');
      // The shared database enforces account-level limits as well as the library's
      // per-IP limits. Hash keys so email addresses never enter rate-limit records.
      const key = `starter-auth:${path}:${createHash('sha256').update(input.email || req.ip || 'unknown').digest('hex')}`;
      const { rows: [limit] } = await db.query('SELECT check_rate_limit($1,$2,$3) AS allowed', [key, path === '/sign-out' ? 60 : 10, 60]);
      if (!limit?.allowed) { res.set('Retry-After', '60'); return publicError(res, 429, 'rate_limited', 'Too many attempts. Try again in a minute.'); }
      if (path === '/verify-email') {
        await auth.api.verifyEmail({ headers: fromNodeHeaders(req.headers), query: { token: input.token } });
        return res.json({ status: true });
      }
      const headers = fromNodeHeaders(req.headers);
      headers.delete('content-length'); headers.delete('host'); headers.delete('authorization');
      headers.set('content-type', 'application/json'); headers.set('x-starter-auth-ip', req.ip || '127.0.0.1');
      snapshot = path === '/sign-in/email'
        ? (await db.query('SELECT id AS \"userId\",credential_version AS \"credentialVersion\" FROM auth_users WHERE email=$1', [input.email])).rows[0] : undefined;
      const response = await signInContext.run(snapshot, () => auth.handler(new Request(`${config.baseURL}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(input) })));
      // Set-Cookie stays in headers only. Never pass upstream JSON, redirects,
      // session bearer tokens, OAuth tokens, user-supplied fields, or debug data.
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.set('Set-Cookie', cookies);
      if (response.status >= 500) {
        if (snapshot) {
          const current = (await db.query('SELECT credential_version,disabled FROM auth_users WHERE id=$1', [snapshot.userId])).rows[0];
          if (!current || current.disabled || current.credential_version !== snapshot.credentialVersion) return publicError(res, 401, 'authentication_required', 'Your credentials changed. Sign in again.');
        }
        return publicError(res, 503, 'authentication_unavailable', 'Authentication is temporarily unavailable.');
      }
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (['FAILED_TO_CREATE_USER', 'FAILED_TO_CREATE_SESSION', 'FAILED_TO_UPDATE_USER', 'FAILED_TO_GET_SESSION', 'FAILED_TO_CREATE_VERIFICATION'].includes(result.code)) return publicError(res, 503, 'authentication_unavailable', 'Authentication is temporarily unavailable.');
        const status = response.status === 429 ? 429 : response.status;
        if (status === 429) res.set('Retry-After', '60');
        return publicError(res, status, Object.hasOwn(errors, result.code) ? result.code : status === 429 ? 'rate_limited' : 'invalid_request', errors[result.code] || (status === 429 ? 'Too many attempts. Try again in a minute.' : 'The authentication request could not be completed.'));
      }
      return res.json({ status: true });
    } catch (error) {
      if (snapshot) {
        try {
          const current = (await db.query('SELECT credential_version,disabled FROM auth_users WHERE id=$1', [snapshot.userId])).rows[0];
          if (!current || current.disabled || current.credential_version !== snapshot.credentialVersion) return publicError(res, 401, 'authentication_required', 'Your credentials changed. Sign in again.');
        } catch { /* Database failures below remain 503. */ }
      }
      if (error.code === 'identity_conflict') return publicError(res, 409, error.code, error.message);
      if (error.status === 401) return publicError(res, 401, 'authentication_required', 'Sign in to continue.');
      if (Object.hasOwn(errors, error.body?.code)) return publicError(res, 400, error.body.code, errors[error.body.code]);
      return publicError(res, 503, 'authentication_unavailable', 'Authentication is temporarily unavailable.');
    }
  });
  router.use((error, req, res, next) => publicError(res, error.type === 'entity.too.large' ? 413 : 400, 'invalid_request', 'Invalid authentication request.'));
  return {
    config, router, mail, auth,
    async verifyRequest(req) { const result = await readSession(req); const { session, ...principal } = result; return principal; },
    findUser: findSelfHostedUser,
    csrf(req, res, next) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && authCookie(req) && !trustedWrite(req, config)) return publicError(res, 403, 'invalid_origin', 'Request origin is not allowed.');
      return next();
    },
    async drainMail() { await Promise.allSettled([...pendingMail]); },
    mailHealthy() { return !mailFailed; },
    async readiness() {
      if (mailFailed) return 'mail_unavailable';
      const { rows: [schema] } = await db.query(`SELECT
        current_setting('session_replication_role')='origin'
        AND to_regclass('auth_users') IS NOT NULL AND to_regclass('auth_accounts') IS NOT NULL
        AND to_regclass('auth_sessions') IS NOT NULL AND to_regclass('auth_verifications') IS NOT NULL
        AND to_regclass('auth_rate_limits') IS NOT NULL AND to_regclass('identity_bindings') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('auth_sessions') AND tgname='auth_session_credential' AND tgenabled IN ('O','A'))
        AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('auth_accounts') AND tgname='auth_password_revoke' AND tgenabled IN ('O','A'))
        AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('auth_users') AND tgname='auth_disabled_revoke' AND tgenabled IN ('O','A')) AS ready`);
      return schema?.ready ? 'ready' : 'schema_unavailable';
    },
  };
}
