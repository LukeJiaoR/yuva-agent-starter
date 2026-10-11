import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AuthContext } from './useAuth.js';
import { authRequest } from './api.js';
import { authErrorMessage, consumeAuthFragment, createRequestScope } from './state.js';
import { AuthDialog } from './components.jsx';
import './auth.css';

const anonymous = { user: null, session: null, profile: null };

export function AuthProvider({ initialLink, children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [session, setSession] = useState(anonymous);
  const [sessionStatus, setSessionStatus] = useState('loading');
  const [sessionError, setSessionError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(initialLink ? { ...initialLink, id: 1 } : null);
  const activeDialog = useRef(dialog);
  const dialogCancellation = useRef(null);
  const sequence = useRef(1);
  const sessionRequests = useRef(createRequestScope());
  const configRequests = useRef(createRequestScope());
  const enabled = config?.mode === 'self-hosted' && config.enabled === true;

  const registerDialogCancellation = useCallback((id, cancel) => {
    dialogCancellation.current = { id, cancel };
    return () => {
      if (dialogCancellation.current?.id === id) dialogCancellation.current = null;
    };
  }, []);

  const open = useCallback((view, options = {}) => {
    dialogCancellation.current?.cancel();
    // Scrub the original bootstrap reference as well as the departing view.
    if (initialLink) initialLink.token = '';
    if (activeDialog.current) activeDialog.current.token = '';
    const next = { ...options, view, id: ++sequence.current };
    activeDialog.current = next;
    setNotice('');
    setDialog(next);
  }, [initialLink]);

  const close = useCallback(() => {
    dialogCancellation.current?.cancel();
    if (['verify', 'reset'].includes(activeDialog.current?.view)) {
      setNotice('The email link was cleared. Reopen the email to continue. If a request was in progress, it may have completed; you can try signing in.');
    }
    if (initialLink) initialLink.token = '';
    if (activeDialog.current) activeDialog.current.token = '';
    activeDialog.current = null;
    setDialog(null);
  }, [initialLink]);

  const refreshSession = useCallback(async (externalSignal) => {
    // A departed dialog must not cancel a newer, still-active session refresh.
    externalSignal?.throwIfAborted();
    // Overlapping read-only refreshes use latest-response ownership rather than
    // aborting each other: a focus refresh must not interrupt a completed login
    // or reset that is waiting for its own account reconciliation.
    const ticket = sessionRequests.current.begin({ abortPrevious: false });
    const signal = externalSignal ? AbortSignal.any([ticket.controller.signal, externalSignal]) : ticket.controller.signal;
    try {
      const result = await authRequest('/get-session', { signal });
      if (sessionRequests.current.isCurrent(ticket) && !signal.aborted) {
        setSession(result);
        setSessionStatus(result.user ? 'authenticated' : 'anonymous');
        setSessionError('');
      }
      return result;
    } catch (error) {
      if (sessionRequests.current.isCurrent(ticket) && !signal.aborted) {
        setSession(anonymous);
        if (error.status === 401) {
          setSessionStatus('anonymous');
          setSessionError('Your session has expired. Sign in again to continue.');
          return anonymous;
        }
        setSessionStatus('error');
        setSessionError(authErrorMessage(error));
      }
      throw error;
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    const ticket = configRequests.current.begin();
    setConfigError('');
    try {
      const result = await authRequest('/config', { signal: ticket.controller.signal });
      if (!configRequests.current.isCurrent(ticket)) return;
      setConfig(result);
      if (result.mode === 'self-hosted' && result.enabled) {
        await refreshSession(ticket.controller.signal).catch(() => {});
      } else {
        setSessionStatus('disabled');
      }
    } catch (error) {
      if (configRequests.current.isCurrent(ticket) && error.name !== 'AbortError') setConfigError(authErrorMessage(error));
    }
  }, [refreshSession]);

  useEffect(() => {
    refreshConfig();
    return () => {
      configRequests.current.cancel();
      sessionRequests.current.cancel();
    };
  }, [refreshConfig]);

  useEffect(() => {
    const onNavigation = () => {
      const link = consumeAuthFragment(window);
      if (link) open(link.view, { token: link.token });
    };
    const onPopState = () => {
      const link = consumeAuthFragment(window);
      if (link) open(link.view, { token: link.token });
      else if (activeDialog.current) close();
    };
    const onPageHide = () => {
      dialogCancellation.current?.cancel();
      if (initialLink) initialLink.token = '';
      if (activeDialog.current) activeDialog.current.token = '';
      activeDialog.current = null;
      setDialog(null);
    };
    const onFocus = () => { if (enabled) refreshSession().catch(() => {}); };
    window.addEventListener('hashchange', onNavigation);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('hashchange', onNavigation);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, open, close, initialLink, refreshSession]);

  return (
    <AuthContext.Provider value={{ config, configError, enabled, session, sessionStatus, sessionError, refreshSession, refreshConfig, open, close, registerDialogCancellation, notice, clearNotice: () => setNotice('') }}>
      {children}
      {dialog && <AuthDialog key={dialog.id} dialog={dialog} />}
    </AuthContext.Provider>
  );
}
