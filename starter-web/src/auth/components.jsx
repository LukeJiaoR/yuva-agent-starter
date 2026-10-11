import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { X, UserCircle, ShieldCheck, EnvelopeSimple } from '@phosphor-icons/react';
import { useAuth } from './useAuth.js';
import { useRequest } from './useRequest.js';
import { authRequest } from './api.js';
import { reconcileRevokedSession, resetPasswordAndRefresh, signInWithProfile } from './flows.js';
import { authErrorMessage, passwordError, readDevelopmentLink } from './state.js';

const mailNotice = 'If this address is eligible, an email is on its way. Check your inbox and spam folder, then use the latest link.';
const titles = {
  signin: 'Welcome back', signup: 'Create your account', forgot: 'Reset your password',
  resend: 'Verify your email', verify: 'Confirm your email', reset: 'Choose a new password',
  account: 'Your account', 'invalid-link': 'This link cannot be used',
};

function Message({ error, children }) {
  return <p className={`auth-message ${error ? 'auth-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</p>;
}

export function AccountControl() {
  const auth = useAuth();
  if (auth.config && !auth.enabled) return null;
  if (!auth.config && !auth.configError) return <span className="auth-loading" role="status">Checking account</span>;
  return (
    <button className="secondary-button account-trigger" type="button" onClick={() => {
      auth.open(auth.session.user ? 'account' : 'signin');
      // A canceled sign-in/sign-out can still finish on the server. Reconcile
      // its cookie whenever the account is opened, without navigating on reply.
      if (auth.enabled) auth.refreshSession().catch(() => {});
    }}>
      <UserCircle size={19} aria-hidden="true" />
      <span>{auth.configError ? 'Account unavailable' : auth.session.user ? 'Account' : 'Sign in'}</span>
    </button>
  );
}

export function AuthNotice() {
  const { notice, clearNotice } = useAuth();
  if (!notice) return null;
  return <div className="auth-notice"><p role="status">{notice}</p><button type="button" className="auth-link" onClick={clearNotice}>Dismiss</button></div>;
}

export function AuthDialog({ dialog }) {
  const auth = useAuth();
  const { busy, run, cancel } = useRequest();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(dialog.email || '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [info, setInfo] = useState(dialog.info || '');
  const element = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const view = dialog.view;

  const clearSecrets = () => { setPassword(''); setConfirmation(''); };
  const navigate = (next, options = {}) => {
    cancel(); clearSecrets();
    const interruptedLink = ['verify', 'reset'].includes(view) && next === 'signin' && !options.info;
    auth.open(next, interruptedLink ? { ...options, info: 'The email link was cleared. Reopen the email to continue verification or password reset.' } : options);
  };
  const dismiss = () => { cancel(); clearSecrets(); auth.close(); };

  useLayoutEffect(() => auth.registerDialogCancellation(dialog.id, cancel), [auth.registerDialogCancellation, dialog.id, cancel]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const node = element.current;
    node.showModal();
    document.body.style.overflow = 'hidden';
    node.querySelector('[data-auth-focus]')?.focus();
    return () => {
      node.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function fail(requestError) {
    clearSecrets();
    setError(authErrorMessage(requestError, view));
    setErrorCode(requestError.code || '');
  }

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError(''); setErrorCode(''); setInfo('');
    if (view === 'signup' || view === 'reset') {
      const validation = passwordError(password, view === 'reset' ? confirmation : password);
      if (validation) { setError(validation); return; }
    }
    const requests = {
      signin: (signal) => signInWithProfile({ email: email.trim(), password }, auth.refreshSession, signal),
      signup: (signal) => authRequest('/sign-up/email', { body: { name: name.trim(), email: email.trim(), password }, signal }),
      forgot: (signal) => authRequest('/request-password-reset', { body: { email: email.trim() }, signal }),
      resend: (signal) => authRequest('/send-verification-email', { body: { email: email.trim() }, signal }),
      verify: (signal) => authRequest('/verify-email', { body: { token: dialog.token }, signal }),
      reset: (signal) => resetPasswordAndRefresh({ token: dialog.token, newPassword: password }, auth.refreshSession, signal),
    };
    const operation = requests[view];
    if (!operation) return;
    run(operation, () => {
      clearSecrets();
      if (view === 'signin') navigate('account');
      else if (view === 'verify') navigate('signin', { info: 'Your email is verified. Sign in to continue.' });
      else if (view === 'reset') navigate('signin', { info: 'Your password was reset. Sign in again with your new password.' });
      else setInfo(mailNotice);
    }, fail);
  }

  function signOut() {
    setError('');
    run(async (signal) => {
      await authRequest('/sign-out', { body: {}, signal });
      return auth.refreshSession(signal);
    }, () => navigate('signin', { info: 'You are signed out.' }), fail);
  }

  const hasEmail = ['signin', 'signup', 'forgot', 'resend'].includes(view);
  const hasPassword = ['signin', 'signup', 'reset'].includes(view);
  const heading = !auth.config ? 'Account connection' : titles[view];
  const showForm = auth.enabled && ['signin', 'signup', 'forgot', 'resend', 'verify', 'reset'].includes(view);
  const buttonText = { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset email', resend: 'Send verification email', verify: 'Verify my email', reset: 'Reset password' }[view];

  return (
    <dialog className="auth-dialog" ref={element} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onClick={(event) => { if (event.target === element.current) dismiss(); }}>
      <div className="auth-dialog-content">
        <div className="auth-dialog-header">
          <div><p className="panel-kicker">Account</p><h2 id={titleId} tabIndex={-1} data-auth-focus>{heading}</h2></div>
          <button type="button" className="icon-button" onClick={dismiss} aria-label="Close account dialog"><X size={19} aria-hidden="true" /></button>
        </div>
        <p className="auth-description" id={descriptionId}>{view === 'verify' ? 'Only confirm if you requested this email. Opening the link does not verify your account.'
          : view === 'reset' ? 'Use a unique password with 12 to 128 characters. You will need to sign in again afterward.'
            : view === 'signup' ? 'Create an account, verify your email, then sign in to your workspace.'
              : view === 'account' ? 'Manage your account and the devices signed in to it.'
                : 'Your account is secured with an HTTP-only session cookie.'}</p>

        {!auth.config && (auth.configError
          ? <><Message error>{auth.configError}</Message><button className="secondary-button" type="button" onClick={auth.refreshConfig}>Retry connection</button></>
          : <Message>Connecting to account services…</Message>)}
        {auth.config && !auth.enabled && <Message error>Email sign-in is not enabled on this installation. Contact your operator for the sign-in method used here.</Message>}
        {auth.enabled && view === 'invalid-link' && <><Message error>The email link is missing or malformed. Request a new email and use its latest link.</Message><button type="button" className="secondary-button" onClick={() => navigate('signin')}>Back to sign in</button></>}

        {showForm && <form onSubmit={submit} aria-busy={busy}>
          {view === 'signin' && auth.sessionError && !error && <Message error>{auth.sessionError}</Message>}
          {view === 'signin' && auth.session.user && <p className="auth-help">Already signed in as {auth.session.user.email}. You can sign in again for a fresh session, or <button className="auth-link" type="button" onClick={() => navigate('account')}>view your account</button>.</p>}
          {view === 'signup' && <label className="field"><span>Name</span><input name="name" autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></label>}
          {hasEmail && <label className="field"><span>Email</span><input name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck="false" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>}
          {hasPassword && <label className="field"><span>{view === 'reset' ? 'New password' : 'Password'}</span><input name="password" type="password" autoComplete={view === 'signin' ? 'current-password' : 'new-password'} required minLength={view === 'signin' ? undefined : 12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />{view !== 'signin' && <small>12 to 128 characters. Spaces and password managers are welcome.</small>}</label>}
          {view === 'reset' && <label className="field"><span>Confirm new password</span><input name="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} /></label>}
          {view === 'verify' && <div className="auth-link-confirm"><EnvelopeSimple size={32} aria-hidden="true" /><p>Ready to confirm this email address?</p></div>}
          {error && <Message error>{error}</Message>}
          {info && <Message>{info}</Message>}
          <button className="primary-button" type="submit" disabled={busy || (['verify', 'reset'].includes(view) && !dialog.token)}>{busy ? 'Please wait…' : buttonText}</button>
        </form>}

        {auth.enabled && view === 'account' && <>
          {auth.session.user ? <>
            <div className="auth-account-summary"><ShieldCheck size={28} aria-hidden="true" /><div><strong>{auth.session.profile?.display_name || auth.session.user.name || 'Your account'}</strong><span>{auth.session.user.email}</span><small>{auth.session.user.emailVerified ? 'Email verified' : 'Email not verified'}</small></div></div>
            {!auth.session.profile && <Message error>Your product account is not linked. If you already had an account with this email, contact your operator for explicit recovery or identity linking. Existing accounts are never claimed automatically.</Message>}
            {error && <Message error>{error}</Message>}
            {info && <Message>{info}</Message>}
            <div className="auth-account-actions"><button className="secondary-button" type="button" disabled={busy} onClick={signOut}>{busy ? 'Please wait…' : 'Sign out'}</button>
              {!auth.session.profile && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setError(''); run(async (signal) => { await authRequest('/provision', { body: {}, signal }); return auth.refreshSession(signal); }, () => setInfo('Your product account is ready.'), fail); }}>Retry account setup</button>}
            </div>
            <Sessions key={auth.session.user.id} onSignIn={() => navigate('signin', { email: auth.session.user.email, info: 'Sign in again to continue managing your sessions.' })} />
          </> : <><Message error>{auth.sessionError || 'You are signed out. Sign in to manage your account.'}</Message><button className="secondary-button" type="button" onClick={() => navigate('signin')}>Sign in</button></>}
        </>}

        {errorCode === 'session_not_fresh' && <button type="button" className="auth-link" onClick={() => navigate('signin', { email })}>Sign in again</button>}
        {errorCode === 'identity_conflict' && auth.session.user && <button type="button" className="auth-link" onClick={() => navigate('account')}>Manage signed-in account</button>}
        {auth.enabled && view !== 'account' && <nav className="auth-navigation" aria-label="Account options">
          {view === 'signin' ? <><button type="button" className="auth-link" onClick={() => navigate('signup')}>Create an account</button><button type="button" className="auth-link" onClick={() => navigate('forgot', { email })}>Forgot password?</button><button type="button" className="auth-link" onClick={() => navigate('resend', { email })}>Resend verification email</button></>
            : <button type="button" className="auth-link" onClick={() => navigate('signin', { email })}>Back to sign in</button>}
        </nav>}
        <button type="button" className="auth-link auth-cancel" onClick={dismiss}>{busy ? 'Cancel and close' : 'Close'}</button>
        {auth.enabled && auth.config.capture && <DevelopmentInbox openLink={(link) => navigate(link.view, { token: link.token })} />}
      </div>
    </dialog>
  );
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unavailable' : date.toLocaleString();
}

function Sessions({ onSignIn }) {
  const { refreshSession } = useAuth();
  const { busy, run } = useRequest();
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [requiresSignIn, setRequiresSignIn] = useState(false);
  const [info, setInfo] = useState('');
  const fail = (requestError) => {
    setError(authErrorMessage(requestError));
    setRequiresSignIn(requestError.code === 'session_not_fresh' || requestError.status === 401);
    reconcileRevokedSession(requestError, refreshSession);
  };
  const load = () => { setError(''); setInfo(''); run((signal) => authRequest('/sessions', { signal }), (data) => setSessions(data.sessions || []), fail); };
  // Explicit refresh keeps this panel usable after another device changes a session.
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function revoke(sessionId) {
    setError(''); setInfo('');
    run(async (signal) => {
      await authRequest(sessionId ? '/revoke-session' : '/revoke-other-sessions', { body: sessionId ? { sessionId } : {}, signal });
      const result = await authRequest('/sessions', { signal });
      await refreshSession(signal);
      return result;
    }, (data) => { setSessions(data.sessions || []); setInfo(sessionId ? 'That session was signed out.' : 'All other sessions were signed out.'); }, fail);
  }
  return <section className="auth-sessions" aria-labelledby="auth-sessions-title" aria-busy={busy}>
    <div className="auth-section-heading"><h3 id="auth-sessions-title">Active sessions</h3><button type="button" className="auth-link" disabled={busy} onClick={load}>Refresh</button></div>
    <p className="auth-help">Session changes require a sign-in within the last five minutes.</p>
    {error && <Message error>{error}</Message>}{info && <Message>{info}</Message>}
    {requiresSignIn && <button type="button" className="secondary-button" onClick={onSignIn}>Sign in again</button>}
    {!sessions && !error && <p role="status" className="auth-help">Loading sessions…</p>}
    {sessions?.length === 0 && <p className="auth-help">No active sessions. Sign in again if needed.</p>}
    {sessions && <ul className="auth-session-list">{sessions.map((session) => <li key={session.id}>
      <div><strong>{session.current ? 'This device' : 'Another device'}</strong><span>{session.userAgent || 'Browser details unavailable'}</span><small>Signed in: {formatDate(session.createdAt)}<br />Expires: {formatDate(session.expiresAt)}</small></div>
      {session.current ? <span className="auth-current">Current</span> : <button className="auth-link" type="button" disabled={busy} onClick={() => revoke(session.id)} aria-label={`Sign out session created ${formatDate(session.createdAt)}`}>Sign out</button>}
    </li>)}</ul>}
    {sessions?.some((session) => !session.current) && <button type="button" className="secondary-button" disabled={busy} onClick={() => revoke()}>Sign out all other sessions</button>}
  </section>;
}

function DevelopmentInbox({ openLink }) {
  const { busy, run } = useRequest();
  const [messages, setMessages] = useState(null);
  const [error, setError] = useState('');
  function refresh() {
    setError('');
    run((signal) => authRequest('/dev/mail', { signal, headers: { 'X-Starter-Dev-Inbox': '1' } }),
      (result) => setMessages(result.messages || []), (requestError) => setError(authErrorMessage(requestError)));
  }
  return <details className="auth-dev-inbox">
    <summary>Development inbox · local only</summary>
    <p>Development mail capture is enabled. These emails are available only on this local, non-production installation.</p>
    <button className="secondary-button" type="button" onClick={refresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh development inbox'}</button>
    {error && <Message error>{error}</Message>}
    {messages?.length === 0 && <p role="status">No captured emails yet.</p>}
    {messages && <ul>{messages.map((message) => <li key={message.id}>
      <span>{message.type === 'verify' ? 'Verify email' : 'Reset password'} · {message.to}</span>
      <small>{formatDate(message.createdAt)}</small>
      <button type="button" className="auth-link" onClick={() => {
        const link = readDevelopmentLink(message.url, window.location.origin);
        if (!link || link.view === 'invalid-link') setError('This email link is invalid or belongs to a different site.');
        else openLink(link);
      }}>Open {message.type === 'verify' ? 'verification' : 'reset'} link</button>
    </li>)}</ul>}
  </details>;
}
