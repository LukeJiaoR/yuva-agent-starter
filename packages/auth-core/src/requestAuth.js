/** Provider-neutral HTTP authentication and local profile mapping. */
export function authenticationError(res, message = 'Not authenticated') {
  return res.status(401).json({ error: message, code: 'authentication_required' });
}

export function authInfrastructureError(res) {
  return res.status(503).json({
    error: 'Authentication is temporarily unavailable',
    code: 'authentication_unavailable',
  });
}

export function createRequestAuthMiddleware({
  verifyRequest,
  findUser,
  db,
  optional,
  useClerk,
  profileRequiredError,
  profileRequiredCode,
  profileUnavailableError,
  profileUnavailableCode,
}) {
  if (typeof verifyRequest !== 'function' || typeof findUser !== 'function') {
    throw new TypeError('Authentication requires verifyRequest and findUser functions');
  }

  return async function requestAuth(req, res, next) {
    // Never reuse a principal or profile left by an earlier middleware invocation.
    req.auth = null;
    req.clerkAuth = null;
    req.user = null;

    let auth;
    try {
      auth = await verifyRequest(req);
    } catch {
      return authInfrastructureError(res);
    }
    if (auth?.kind === 'missing') {
      return optional ? next() : authenticationError(res);
    }
    if (auth?.kind === 'invalid') return authenticationError(res);
    if (auth?.kind !== 'authenticated' || typeof auth.userId !== 'string' || !auth.userId.trim()) {
      // Unknown or malformed adapter results are infrastructure failures, not guests.
      return authInfrastructureError(res);
    }

    req.auth = auth;
    if (useClerk) req.clerkAuth = auth;
    try {
      // The third argument carries verified provider/tenant context to the mapper.
      const user = await findUser(auth.userId, db, auth);
      if (!useClerk && user != null && (typeof user !== 'object' || Array.isArray(user)
        || typeof user.id !== 'string' || !user.id.trim())) {
        throw new TypeError('Custom authentication requires a valid local user profile');
      }
      req.user = user ?? null;
    } catch {
      return res.status(503).json({
        error: profileUnavailableError,
        code: profileUnavailableCode,
      });
    }
    if (!req.user && (!optional || !useClerk)) {
      return res.status(409).json({ error: profileRequiredError, code: profileRequiredCode });
    }
    return next();
  };
}
