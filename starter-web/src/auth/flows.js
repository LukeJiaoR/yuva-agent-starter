import { authRequest } from './api.js';

export async function signInWithProfile(credentials, refreshSession, signal) {
  await authRequest('/sign-in/email', { body: credentials, signal });
  signal?.throwIfAborted();
  try {
    await authRequest('/provision', { body: {}, signal });
  } catch (error) {
    signal?.throwIfAborted();
    // A legacy identity conflict still leaves an authenticated auth account.
    // Reflect it so the user can explicitly sign out or ask for recovery.
    await refreshSession(signal).catch(() => {});
    throw error;
  }
  signal?.throwIfAborted();
  return refreshSession(signal);
}

export async function resetPasswordAndRefresh(body, refreshSession, signal) {
  await authRequest('/reset-password', { body, signal });
  signal?.throwIfAborted();
  // A successful reset revokes existing cookies server-side. Refresh the global
  // account state before asking the user to sign in with the new password.
  await refreshSession(signal).catch((error) => {
    if (error.name === 'AbortError') throw error;
    // The password reset already succeeded. The provider clears stale identity
    // on an unavailable session read; do not invite another reset submission.
  });
  signal?.throwIfAborted();
}

export function reconcileRevokedSession(error, refreshSession) {
  if (error.status === 401) return refreshSession().catch(() => {});
  return Promise.resolve();
}
