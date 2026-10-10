import { verifyToken } from '@clerk/backend';
import { TokenVerificationErrorReason } from '@clerk/backend/errors';
import { authenticationError, authInfrastructureError, createRequestAuthMiddleware } from './requestAuth.js';

const INVALID_TOKEN_REASONS = new Set([
  TokenVerificationErrorReason.TokenVerificationFailed,
  TokenVerificationErrorReason.TokenExpired,
  TokenVerificationErrorReason.TokenInvalid,
  TokenVerificationErrorReason.TokenInvalidAlgorithm,
  TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
  TokenVerificationErrorReason.TokenInvalidSignature,
  TokenVerificationErrorReason.TokenNotActiveYet,
  TokenVerificationErrorReason.TokenIatInTheFuture,
]);

function normalizeOrigin(value) {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch {
    return '';
  }
}

export function getClerkAuthorizedParties(env = process.env) {
  const explicit = String(env.CLERK_AUTHORIZED_PARTIES || '').trim();
  const configured = explicit
    ? [explicit]
    : [env.FRONTEND_URL, env.CORS_ORIGIN];
  const values = configured
    .flatMap((value) => String(value || '').split(','))
    .map(normalizeOrigin)
    .filter(Boolean);

  if (!values.length && env.NODE_ENV !== 'production') {
    values.push('http://localhost:45173', 'http://127.0.0.1:45173', 'http://localhost:45174', 'http://127.0.0.1:45174');
  }
  return [...new Set(values)];
}

function clerkJwtKey(env = process.env) {
  return String(env.CLERK_JWT_KEY || '').trim().replace(/\\n/g, '\n');
}

function clerkSecretKey(env = process.env) {
  return String(env.CLERK_SECRET_KEY || '').trim();
}

function readBearerToken(req) {
  const value = req.headers?.authorization;
  if (!value) return { kind: 'missing', token: null };
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  if (!match) return { kind: 'invalid', token: null };
  return { kind: 'present', token: match[1] };
}

function isInvalidClerkTokenError(error) {
  return INVALID_TOKEN_REASONS.has(error?.reason);
}

function isInvalidSignatureError(error) {
  return error?.reason === TokenVerificationErrorReason.TokenInvalidSignature;
}

function verificationErrors(verification) {
  return Array.isArray(verification?.errors)
    ? verification.errors.filter(Boolean)
    : [];
}

function shouldRetryWithClerkJwks(verification) {
  const errors = verificationErrors(verification);
  return errors.length > 0 && errors.every(isInvalidSignatureError);
}

async function verifyClerkToken(tokenVerifier, token, {
  jwtKey,
  secretKey,
  authorizedParties,
}) {
  if (!jwtKey) {
    return tokenVerifier(token, {
      secretKey,
      authorizedParties,
    });
  }

  try {
    const verification = await tokenVerifier(token, {
      jwtKey,
      authorizedParties,
    });
    if (!secretKey || !shouldRetryWithClerkJwks(verification)) return verification;
    return tokenVerifier(token, {
      secretKey,
      authorizedParties,
    });
  } catch (error) {
    if (!secretKey || !isInvalidSignatureError(error)) throw error;
    return tokenVerifier(token, {
      secretKey,
      authorizedParties,
    });
  }
}

export async function verifyClerkRequest(req, {
  env = process.env,
  tokenVerifier = verifyToken,
} = {}) {
  const bearer = readBearerToken(req);
  if (bearer.kind !== 'present') return bearer;

  const jwtKey = clerkJwtKey(env);
  const secretKey = clerkSecretKey(env);
  const authorizedParties = getClerkAuthorizedParties(env);
  if ((!jwtKey && !secretKey) || !authorizedParties.length) {
    return { kind: 'unavailable', token: null };
  }

  try {
    const verification = await verifyClerkToken(tokenVerifier, bearer.token, {
      jwtKey,
      secretKey,
      authorizedParties,
    });
    const errors = verificationErrors(verification);
    if (errors.length) {
      if (errors.every(isInvalidClerkTokenError)) {
        return { kind: 'invalid', token: null };
      }
      console.error(
        'Clerk token verification unavailable:',
        errors[0]?.message || errors[0],
      );
      return { kind: 'unavailable', token: null };
    }

    const hasVerificationEnvelope = verification
      && (Object.prototype.hasOwnProperty.call(verification, 'data')
        || Object.prototype.hasOwnProperty.call(verification, 'errors'));
    const claims = hasVerificationEnvelope ? verification.data : verification;
    const userId = String(claims?.sub || '').trim();
    if (!userId) return { kind: 'invalid', token: null };
    return {
      kind: 'authenticated',
      claims,
      sessionId: String(claims.sid || '').trim() || null,
      userId,
    };
  } catch (error) {
    if (isInvalidClerkTokenError(error)) {
      return { kind: 'invalid', token: null };
    }
    console.error('Clerk token verification unavailable:', error?.message || error);
    return { kind: 'unavailable', token: null };
  }
}

export async function findMappedClerkUser(externalId, queryable) {
  if (!queryable) throw new Error('Database queryable instance is required to find mapped user');
  const { rows } = await queryable.query(
    `SELECT id, email, display_name,
            external_auth_provider, external_auth_id, memory_enabled
       FROM users
      WHERE external_auth_provider = 'clerk' AND external_auth_id = $1`,
    [externalId],
  );
  return rows[0] || null;
}

export async function requireClerkAuth(req, res, next, options = {}) {
  const auth = await verifyClerkRequest(req, options);
  if (auth.kind === 'missing' || auth.kind === 'invalid') {
    return authenticationError(res);
  }
  if (auth.kind === 'unavailable') return authInfrastructureError(res);

  req.clerkAuth = auth;
  return next();
}

/**
 * Preserve the Clerk defaults while allowing a trusted, request-level verifier.
 * A custom verifier must also supply its own explicit local-user mapping.
 */
function requestAuthOptions({
  db,
  findUser,
  verifyRequest,
  profileRequiredError = 'User profile setup is required',
  profileRequiredCode = 'user_profile_required',
  profileUnavailableError = 'User profile is temporarily unavailable',
  profileUnavailableCode = 'user_profile_unavailable',
  env = process.env,
  tokenVerifier = verifyToken,
} = {}) {
  const useClerk = verifyRequest === undefined;
  if (!useClerk && (typeof verifyRequest !== 'function' || typeof findUser !== 'function')) {
    throw new TypeError('Custom authentication requires verifyRequest and findUser functions');
  }
  return {
    db,
    findUser: useClerk && findUser === undefined ? findMappedClerkUser : findUser,
    verifyRequest: useClerk ? (req) => verifyClerkRequest(req, { env, tokenVerifier }) : verifyRequest,
    useClerk,
    profileRequiredError,
    profileRequiredCode,
    profileUnavailableError,
    profileUnavailableCode,
  };
}

/** Create required authentication with a separate, product-owned user mapping. */
export function createRequireAuth(options = {}) {
  return createRequestAuthMiddleware({ ...requestAuthOptions(options), optional: false });
}

/** Optional authentication permits missing credentials, never invalid credentials. */
export function createOptionalAuth(options = {}) {
  return createRequestAuthMiddleware({ ...requestAuthOptions(options), optional: true });
}

/**
 * Factory for creating database-backed rate limiter middleware.
 */
export function createDbRateLimiter({ db }) {
  return function dbRateLimit(prefix, max, windowSec, { failClosed = true, bypass = false } = {}) {
    return async (req, res, next) => {
      if (bypass) return next();

      const key = `${prefix}:${req.user?.id || req.ip}`;
      try {
        const { rows } = await db.query('SELECT check_rate_limit($1, $2, $3) AS allowed', [key, max, windowSec]);
        if (!rows[0].allowed) {
          const retryAfterSeconds = Math.max(1, Math.ceil(Number(windowSec) || 1));
          res.set('Retry-After', String(retryAfterSeconds));
          return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
        }
      } catch (err) {
        console.error('Rate limit check failed:', err);
        if (failClosed) {
          return res.status(503).json({ error: 'Rate limit unavailable. Please try again.' });
        }
      }
      return next();
    };
  };
}
