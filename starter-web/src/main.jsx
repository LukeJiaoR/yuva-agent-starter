import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  CheckCircle,
  Code,
  Moon,
  PaperPlaneTilt,
  Sparkle,
  Sun,
  WarningCircle,
} from '@phosphor-icons/react';
import { analyzeInput, checkReadiness, readPricing, streamChat } from './api.js';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { AccountControl, AuthNotice } from './auth/components.jsx';
import { consumeAuthFragment, workspaceIdentity } from './auth/state.js';
import { useAuth } from './auth/useAuth.js';
import { OperationHistory } from './operations/OperationHistory.jsx';
import './styles.css';
import { DemoCheckout } from './checkout/DemoCheckout.jsx';

// Consume email-link fragments before React mounts or any API work begins.
// AuthProvider scrubs this in-memory object when the link is used or dismissed.
const initialAuthLink = consumeAuthFragment(window);

const appName = import.meta.env.VITE_APP_NAME || 'Northstar Agent';
const appDescription = import.meta.env.VITE_APP_DESCRIPTION
  || 'Ground every answer in facts your product controls.';

function initialTheme() {
  const saved = localStorage.getItem('starter-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function Status({ kind, children }) {
  const Icon = kind === 'error' ? WarningCircle : CheckCircle;
  return (
    <div className={`status status-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={17} weight="fill" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function AccountWorkspace() {
  const auth = useAuth();
  // A changed identity gets fresh inputs/results/pricing and a fresh operation
  // namespace. Never reuse another user's draft, result, or pending retry ID.
  return <App key={workspaceIdentity(auth)} />;
}

function App() {
  const auth = useAuth();
  const [view, setView] = useState('workspace');
  const [theme, setTheme] = useState(initialTheme);
  const [readiness, setReadiness] = useState({ state: 'checking', label: 'Checking API' });
  const [subject, setSubject] = useState('A customer renewal decision');
  const [parameters, setParameters] = useState('{\n  "plan": "team",\n  "renewal_month": "October"\n}');
  const [question, setQuestion] = useState('What should the customer success team focus on first?');
  const [analysis, setAnalysis] = useState(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [stage, setStage] = useState('idle');
  const activeRequest = useRef(null);
  const alive = useRef(true);
  const requestSnapshot = useRef(null);
  const submitting = useRef(false);
  const draftRevision = useRef(0);
  const [pricing, setPricing] = useState(null);
  const [quote, setQuote] = useState(null);
  const [charge, setCharge] = useState(null);
  const [financialStatus, setFinancialStatus] = useState(null);

  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activeRequest.current?.abort();
      requestSnapshot.current = null;
    };
  }, []);
  const ownsRequest = (controller) => alive.current && activeRequest.current === controller && !controller.signal.aborted;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.title = appName;
    localStorage.setItem('starter-theme', theme);
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    checkReadiness(controller.signal)
      .then(() => { if (alive.current && !controller.signal.aborted) setReadiness({ state: 'ready', label: 'API ready' }); })
      .catch(() => { if (alive.current && !controller.signal.aborted) setReadiness({ state: 'error', label: 'API unavailable' }); });
    readPricing(controller.signal).then((value) => { if (alive.current && !controller.signal.aborted) setPricing(value); })
      .catch(() => { if (alive.current && !controller.signal.aborted) setPricing(null); });
    return () => controller.abort();
  }, []);

  const parsedParameters = useMemo(() => {
    try {
      return { value: JSON.parse(parameters), error: '' };
    } catch {
      return { value: null, error: 'Parameters must be valid JSON.' };
    }
  }, [parameters]);

  function editDraft(setter, value, affectsFacts = true) {
    if (requestSnapshot.current) return;
    draftRevision.current += 1;
    activeRequest.current?.abort();
    setter(value);
    if (affectsFacts) setAnalysis(null);
    setAnswer(''); setError(''); setStage('idle');
    setQuote(null); setCharge(null); setFinancialStatus(null);
  }

  async function runAnalysis() {
    if (!alive.current) return null;
    if (requestSnapshot.current) return analysis;
    if (parsedParameters.error) {
      setError(parsedParameters.error);
      return;
    }
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setError('');
    setAnswer('');
    setStage('analyzing');
    try {
      const result = await analyzeInput({ subject, parameters: parsedParameters.value }, controller.signal);
      if (!ownsRequest(controller)) return null;
      setAnalysis(result);
      setStage('ready');
      return result;
    } catch (requestError) {
      if (!ownsRequest(controller)) return null;
      if (requestError.name !== 'AbortError') setError(requestError.message);
      setStage('idle');
      return null;
    }
  }

  async function askAgent() {
    if (submitting.current || !alive.current) return;
    if (!requestSnapshot.current && parsedParameters.error) { setError(parsedParameters.error); return; }
    submitting.current = true;
    const revision = draftRevision.current;
    try {
      const activeAnalysis = requestSnapshot.current ? analysis : analysis || await runAnalysis();
      if (!alive.current || !activeAnalysis || revision !== draftRevision.current) return;
      const controller = new AbortController();
      activeRequest.current?.abort();
      activeRequest.current = controller;
      setError('');
      setAnswer('');
      setStage('streaming');
      if (!requestSnapshot.current) {
        requestSnapshot.current = { question, subject, parameters: parsedParameters.value, requestId: crypto.randomUUID() };
        setQuote(null); setCharge(null); setFinancialStatus(null);
      }
      let terminal = false;
      try {
        const response = await streamChat(requestSnapshot.current, {
          signal: controller.signal,
          onEvent(event) {
            if (!ownsRequest(controller)) return;
            const payload = event.data?.data || event.data || {};
            if (event.type === 'start' && payload.pricing) setQuote(payload.pricing);
            if (event.type === 'pending') { setStage('pending'); setFinancialStatus(payload.status); }
            if (event.type === 'text_delta') setAnswer((current) => current + (payload.text || ''));
            if (event.type === 'error') {
              setError(payload.message || 'The agent could not answer.');
              setFinancialStatus(payload.financial_status);
              terminal = ['released','refunded','settled','no_charge'].includes(payload.financial_status);
              setStage(terminal ? 'ready' : 'pending');
              if (terminal) requestSnapshot.current = null;
            }
            if (event.type === 'done') {
              terminal = true; setStage('complete'); setCharge(payload.credits_used);
              setFinancialStatus(payload.financial_status); requestSnapshot.current = null;
            }
          },
        });
        if (!ownsRequest(controller)) return;
        if (!terminal) {
          setStage('pending');
          if (response.status) setFinancialStatus(response.status);
        }
      } catch (requestError) {
        if (!ownsRequest(controller) || terminal) return;
        if (requestError.name !== 'AbortError') setError(requestError.message);
        const knownTerminal = ['released', 'refunded', 'settled', 'no_charge'].includes(requestError.financialStatus)
          || requestError.status === 409 && ['request_released', 'request_refunded'].includes(requestError.code);
        if (knownTerminal || [400,401,402,403,422].includes(requestError.status)) {
          requestSnapshot.current = null; setStage('ready');
          if (knownTerminal) setFinancialStatus(requestError.financialStatus || (requestError.code === 'request_refunded' ? 'refunded' : 'released'));
        } else setStage('pending');
      }
    } finally { submitting.current = false; }
  }

  const busy = stage === 'analyzing' || stage === 'streaming';

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label={`${appName} home`}>
          <span className="brand-mark"><Sparkle size={18} weight="fill" /></span>
          <span>{appName}</span>
        </a>
        <div className="topbar-actions">
          <span className={`api-state api-${readiness.state}`}>{readiness.label}</span>
          <AccountControl />
          <button
            className="icon-button"
            type="button"
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>

      <main className="workspace">
        <AuthNotice />
        {auth.sessionStatus === 'authenticated' && <nav className="workspace-nav" aria-label="Workspace views">
          <button type="button" className="secondary-button" aria-pressed={view === 'workspace'} onClick={() => setView('workspace')}>Workspace</button>
          <button type="button" className="secondary-button" aria-pressed={view === 'history'} onClick={() => setView('history')}>Operation history</button>
          {auth.enabled && <button type="button" className="secondary-button" aria-pressed={view === 'checkout'} onClick={() => setView('checkout')}>Demo credit packs</button>}
        </nav>}
        {view === 'history' ? <OperationHistory /> : view === 'checkout' ? <DemoCheckout /> : <>

        <section className="intro" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Grounded agent workspace</p>
            <h1 id="page-title">Turn controlled facts into a useful answer.</h1>
            <p>{appDescription}</p>
          </div>
          <div className="contract-note">
            <Code size={20} aria-hidden="true" />
            <span>Replace the domain adapter, prompts, and pricing. The runtime stays intact.</span>
          </div>
        </section>

        <section className="work-grid" aria-label="Agent workspace">
          <form className="input-panel" onSubmit={(event) => { event.preventDefault(); runAnalysis(); }}>
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Input</span>
                <h2>Domain facts</h2>
              </div>
              <span className="step-label">Prepare</span>
            </div>

            <label className="field">
              <span>Subject</span>
              <input value={subject} onChange={(event) => editDraft(setSubject, event.target.value)} disabled={busy || Boolean(requestSnapshot.current)} maxLength={240} />
              <small>The person, document, event, or object your adapter will evaluate.</small>
            </label>

            <label className="field">
              <span>Parameters</span>
              <textarea
                className="code-input"
                value={parameters}
                onChange={(event) => editDraft(setParameters, event.target.value)}
                disabled={busy || Boolean(requestSnapshot.current)}
                rows={7}
                spellCheck="false"
                aria-invalid={Boolean(parsedParameters.error)}
              />
              <small className={parsedParameters.error ? 'field-error' : ''}>
                {parsedParameters.error || 'Valid JSON is passed to your deterministic domain adapter.'}
              </small>
            </label>

            <button className="secondary-button" type="submit" disabled={busy || stage === 'pending' || !subject.trim()}>
              {stage === 'analyzing' ? 'Preparing facts' : 'Preview facts'}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>

          <section className="output-panel" aria-labelledby="output-title">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Output</span>
                <h2 id="output-title">Agent answer</h2>
              </div>
              <span className="step-label">Validate</span>
            </div>

            {analysis ? (
              <div className="fact-summary">
                <div>
                  <span>Snapshot</span>
                  <strong>{analysis.facts?.subject}</strong>
                </div>
                <code title={analysis.fingerprint}>{analysis.fingerprint?.slice(0, 16)}</code>
              </div>
            ) : (
              <div className="empty-state">
                <Sparkle size={26} weight="duotone" aria-hidden="true" />
                <h3>Facts appear here first</h3>
                <p>Preview the deterministic snapshot before asking the model to reason over it.</p>
              </div>
            )}

            <label className="field question-field">
              <span>Question</span>
              <textarea value={question} onChange={(event) => editDraft(setQuestion, event.target.value, false)} disabled={busy || Boolean(requestSnapshot.current)} rows={3} maxLength={4000} />
            </label>

            <p role="status">
              {(quote || pricing)?.strategy === 'fixed' ? `${(quote || pricing).credits} credits per completed operation`
                : (quote || pricing)?.strategy === 'token'
                  ? `Input: ${(quote || pricing).inputRate.credits} / ${(quote || pricing).inputRate.tokens} tokens · Output: ${(quote || pricing).outputRate.credits} / ${(quote || pricing).outputRate.tokens} tokens`
                  : 'Pricing unavailable'}
              {(quote || pricing) && ` · Maximum ${(quote || pricing).authorizedCredits} credits`}
              {(quote || pricing)?.strategy === 'token' && (quote || pricing).missingUsage === 'estimate'
                && ' · Missing measurements use frozen budget estimates'}
            </p>
            <button className="primary-button" type="button" onClick={askAgent} disabled={busy || !question.trim() || !pricing}>
              <PaperPlaneTilt size={19} weight="fill" aria-hidden="true" />
              {stage === 'streaming' ? 'Validating answer' : stage === 'pending' ? 'Check result' : analysis ? 'Ask agent' : 'Prepare and continue'}
            </button>

            {busy && <div className="answer-skeleton" aria-label="Agent is working"><span /><span /><span /></div>}
            {error && <Status kind="error">{error}</Status>}
            {stage === 'pending' && <Status kind="pending">{financialStatus === 'reconciliation_required' ? 'Awaiting billing review' : 'Result pending'} · Charges are not final. Inputs are locked to this pending request; checking reuses its saved inputs.</Status>}
            {answer && (
              <article className="answer" aria-live="polite">
                <Status kind="success">{financialStatus === 'no_charge' ? 'Completed without charge' : stage === 'complete' ? 'Completed' : 'Result received'}{charge != null ? ` · ${charge} credits charged` : ''}</Status>
                <p>{answer}</p>
              </article>
            )}
          </section>
        </section>
        </>}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider initialLink={initialAuthLink}><AccountWorkspace /></AuthProvider>
  </React.StrictMode>,
);
