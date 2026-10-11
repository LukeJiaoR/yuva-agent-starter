// Auth links and credentials are deliberately kept out of browser storage.
export function parseAuthFragment(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/u, ''));
  if (!params.has('auth') && !params.has('token')) return null;
  const mode = params.get('auth');
  const token = params.get('token');
  if (!['verify', 'reset'].includes(mode) || params.getAll('auth').length !== 1
    || params.getAll('token').length !== 1 || !token || token.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    return { view: 'invalid-link', token: '' };
  }
  return { view: mode, token };
}

export function consumeAuthFragment(browser) {
  const link = parseAuthFragment(browser.location.hash);
  if (link) {
    // Do this before rendering or making requests. Never put the token in history.state.
    browser.history.replaceState(browser.history.state, '', `${browser.location.pathname}${browser.location.search}`);
  }
  return link;
}

export function readDevelopmentLink(value, origin) {
  try {
    const url = new URL(value);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;
    return parseAuthFragment(url.hash);
  } catch {
    return null;
  }
}

export function passwordError(password, confirmation = password) {
  if (password.length < 12 || password.length > 128) return 'Use a password with 12 to 128 characters.';
  if (password !== confirmation) return 'The passwords do not match.';
  return '';
}

// Every navigation and dismissal invalidates older completions, even if a server
// has already finished an operation and ignores the abort signal.
export function createRequestScope() {
  let sequence = 0;
  let active = null;
  return {
    begin({ abortPrevious = true } = {}) {
      if (abortPrevious) active?.controller.abort();
      active = { id: ++sequence, controller: new AbortController() };
      return active;
    },
    isCurrent(ticket) {
      return ticket.id === sequence && !ticket.controller.signal.aborted;
    },
    cancel() {
      sequence += 1;
      active?.controller.abort();
      active = null;
    },
  };
}

export function authErrorMessage(error, view) {
  if (error.code === 'identity_conflict') {
    return 'This email already belongs to an existing product account. Contact your operator for an explicit account recovery or identity link. We will not claim or merge that account automatically.';
  }
  if (error.code === 'session_not_fresh') return 'For your security, sign in again before changing sessions.';
  if (error.status === 429) return 'Too many attempts. Wait a little, then try again.';
  if (error.status === 503) return 'Account services are temporarily unavailable. Please try again.';
  if (error.status === 401) return view === 'signin'
    ? 'We could not sign you in. Check your email and password, and make sure your email is verified.'
    : 'Your session has expired. Sign in again to continue.';
  if (['EMAIL_NOT_VERIFIED', 'email_not_verified'].includes(error.code)) return 'Verify your email before signing in. You can request another verification email below.';
  if (['verify', 'reset'].includes(view) && [400, 403, 404, 422].includes(error.status)) {
    return 'This email link is invalid, expired, or already used. Request a new email and open its latest link.';
  }
  if (!error.status) return ['verify', 'reset'].includes(view)
    ? 'The connection was interrupted, so we could not confirm the result. You can retry, or reopen the email. If it already completed, try signing in.'
    : 'We could not reach account services. Check your connection and try again.';
  return 'We could not complete that request. Please try again.';
}

// Product buffers and pending operation IDs belong to one authenticated profile.
// Clerk/custom integrations retain their existing lifecycle outside this adapter.
export function workspaceIdentity({ enabled, sessionStatus, session }) {
  if (!enabled) return 'external-auth';
  if (sessionStatus === 'loading') return 'self-hosted:loading';
  if (sessionStatus === 'error') return 'self-hosted:unavailable';
  if (session?.profile?.id) return `self-hosted:profile:${session.profile.id}`;
  if (session?.user?.id) return `self-hosted:unmapped:${session.user.id}`;
  return 'self-hosted:anonymous';
}
