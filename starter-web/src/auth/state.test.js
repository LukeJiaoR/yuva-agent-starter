import { describe, expect, it } from 'vitest';
import { authErrorMessage, consumeAuthFragment, createRequestScope, parseAuthFragment, passwordError, readDevelopmentLink, workspaceIdentity } from './state.js';

describe('auth email links', () => {
  it('reads verification and reset links without performing any request', () => {
    expect(parseAuthFragment('#auth=verify&token=opaque-token')).toEqual({ view: 'verify', token: 'opaque-token' });
    expect(parseAuthFragment('#auth=reset&token=reset-token')).toEqual({ view: 'reset', token: 'reset-token' });
    expect(parseAuthFragment('#workspace')).toBeNull();
  });

  it('removes tokens from the current history entry, retaining existing state and ordinary query', () => {
    const calls = [];
    const historyState = { navigation: 2 };
    const browser = {
      location: { hash: '#auth=verify&token=do-not-retain', pathname: '/workspace', search: '?theme=dark' },
      history: { state: historyState, replaceState(...args) { calls.push(args); browser.location.hash = ''; } },
    };
    expect(consumeAuthFragment(browser)).toEqual({ view: 'verify', token: 'do-not-retain' });
    expect(calls).toEqual([[historyState, '', '/workspace?theme=dark']]);
    expect(JSON.stringify(calls)).not.toContain('do-not-retain');
    expect(consumeAuthFragment(browser)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it.each([
    '#auth=verify', '#token=orphan', '#auth=wrong&token=secret',
    '#auth=verify&auth=reset&token=secret', '#auth=verify&token=a&token=b',
    '#auth=reset&token=', '#auth=reset&token=%20secret', '#auth=verify&token=%00secret', `#auth=reset&token=${'a'.repeat(2049)}`,
  ])('clears malformed links rather than leaving their tokens in history: %s', (hash) => {
    let replacement;
    const browser = { location: { hash, pathname: '/', search: '' }, history: { state: null, replaceState(_state, _title, url) { replacement = url; } } };
    expect(consumeAuthFragment(browser)).toEqual({ view: 'invalid-link', token: '' });
    expect(replacement).toBe('/');
  });

  it('only opens same-origin development mail links and never navigates to their URL', () => {
    expect(readDevelopmentLink('http://localhost:5173/#auth=reset&token=dev-token', 'http://localhost:5173')).toEqual({ view: 'reset', token: 'dev-token' });
    expect(readDevelopmentLink('http://localhost:5174/#auth=reset&token=dev-token', 'http://localhost:5173')).toBeNull();
    expect(readDevelopmentLink('https://example.com/#auth=verify&token=dev-token', 'http://localhost:5173')).toBeNull();
    expect(readDevelopmentLink('javascript:alert(1)', 'http://localhost:5173')).toBeNull();
    expect(readDevelopmentLink('not a URL', 'http://localhost:5173')).toBeNull();
  });
});

describe('password rules', () => {
  it('enforces 12 through 128 characters without trimming password spaces', () => {
    expect(passwordError('a'.repeat(11))).not.toBe('');
    expect(passwordError('a'.repeat(12))).toBe('');
    expect(passwordError('a'.repeat(128))).toBe('');
    expect(passwordError('a'.repeat(129))).not.toBe('');
    expect(passwordError('  long passphrase  ')).toBe('');
    expect(passwordError('  long passphrase  ', 'long passphrase')).toMatch(/match/u);
  });
});

describe('request lifecycle', () => {
  it('invalidates in-flight and already-resolved work immediately when a dialog is dismissed', () => {
    const scope = createRequestScope();
    const first = scope.begin();
    expect(scope.isCurrent(first)).toBe(true);
    scope.cancel();
    expect(first.controller.signal.aborted).toBe(true);
    expect(scope.isCurrent(first)).toBe(false);
    const reopened = scope.begin();
    expect(scope.isCurrent(first)).toBe(false);
    expect(scope.isCurrent(reopened)).toBe(true);
  });

  it('prevents an older response from overwriting newer navigation or a retry', () => {
    const scope = createRequestScope();
    const old = scope.begin();
    const retry = scope.begin();
    expect(old.controller.signal.aborted).toBe(true);
    expect(scope.isCurrent(old)).toBe(false);
    expect(scope.isCurrent(retry)).toBe(true);
    scope.cancel();
    scope.cancel();
    expect(scope.isCurrent(retry)).toBe(false);
  });

  it('lets overlapping session reads finish without interrupting auth actions while ignoring stale state', () => {
    const scope = createRequestScope();
    const loginRefresh = scope.begin({ abortPrevious: false });
    const focusRefresh = scope.begin({ abortPrevious: false });
    expect(loginRefresh.controller.signal.aborted).toBe(false);
    expect(scope.isCurrent(loginRefresh)).toBe(false);
    expect(scope.isCurrent(focusRefresh)).toBe(true);
  });
});

describe('safe user-facing errors', () => {
  it('requires explicit operator recovery for a legacy account conflict', () => {
    expect(authErrorMessage({ status: 409, code: 'identity_conflict' })).toMatch(/operator/u);
    expect(authErrorMessage({ status: 409, code: 'identity_conflict' })).toMatch(/not claim or merge/u);
  });

  it('explains reauthentication, retry, and ambiguous interrupted email requests', () => {
    expect(authErrorMessage({ status: 403, code: 'session_not_fresh' })).toMatch(/sign in again/iu);
    expect(authErrorMessage({ status: 503 })).toMatch(/temporarily unavailable/u);
    expect(authErrorMessage({}, 'reset')).toMatch(/could not confirm the result/u);
    expect(authErrorMessage({ status: 400 }, 'verify')).toMatch(/already used/u);
  });

  it('never displays raw provider errors or their token/password details', () => {
    expect(authErrorMessage({ status: 500, message: 'secret-token', code: 'secret-password' })).not.toMatch(/secret-/u);
  });
});

describe('product identity boundary', () => {
  const state = (id) => ({ enabled: true, sessionStatus: 'authenticated', session: { user: { id: 'auth-' + id }, profile: { id } } });
  it('remounts all product buffers on logout, account switch, missing mapping, or loss of verification', () => {
    const first = workspaceIdentity(state('first'));
    expect(workspaceIdentity(state('second'))).not.toBe(first);
    expect(workspaceIdentity({ enabled: true, sessionStatus: 'anonymous', session: {} })).not.toBe(first);
    expect(workspaceIdentity({ ...state('first'), sessionStatus: 'error' })).not.toBe(first);
    expect(workspaceIdentity({ ...state('first'), session: { user: { id: 'auth-first' }, profile: null } })).not.toBe(first);
  });
  it('keeps the same product profile stable across ordinary session refresh and reauthentication', () => {
    expect(workspaceIdentity({ ...state('first'), session: { ...state('first').session, session: { id: 'new-session' } } })).toBe(workspaceIdentity(state('first')));
    expect(workspaceIdentity({ enabled: false, sessionStatus: 'disabled', session: {} })).toBe('external-auth');
  });
});
