import { verifyToken } from '@clerk/backend';
import { TokenVerificationErrorReason } from '@clerk/backend/errors';

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

/** Loaded only when the Clerk adapter is selected for credential verification. */
export async function verifyClerkIdentity(token, {
  jwtKey,
  secretKey,
  authorizedParties,
  tokenVerifier = verifyToken,
}) {
  try {
    const verification = await verifyClerkToken(tokenVerifier, token, {
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
