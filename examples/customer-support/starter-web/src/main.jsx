import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { analyzeInput, checkReadiness, streamChat } from './api.js';
import './styles.css';

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

function App() {
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.title = appName;
    localStorage.setItem('starter-theme', theme);
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    checkReadiness(controller.signal)
      .then(() => setReadiness({ state: 'ready', label: 'API ready' }))
      .catch(() => setReadiness({ state: 'error', label: 'API unavailable' }));
    return () => controller.abort();
  }, []);

  const parsedParameters = useMemo(() => {
    try {
      return { value: JSON.parse(parameters), error: '' };
    } catch {
      return { value: null, error: 'Parameters must be valid JSON.' };
    }
  }, [parameters]);

  async function runAnalysis() {
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
      setAnalysis(result);
      setStage('ready');
      return result;
    } catch (requestError) {
      if (requestError.name !== 'AbortError') setError(requestError.message);
      setStage('idle');
      return null;
    }
  }

  async function askAgent() {
    const activeAnalysis = analysis || await runAnalysis();
    if (!activeAnalysis) return;
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setError('');
    setAnswer('');
    setStage('streaming');
    try {
      await streamChat({
        question,
        subject,
        parameters: parsedParameters.value,
        requestId: crypto.randomUUID(),
      }, {
        signal: controller.signal,
        onEvent(event) {
          const payload = event.data?.data || event.data || {};
          if (event.type === 'text_delta') setAnswer((current) => current + (payload.text || ''));
          if (event.type === 'error') {
            setError(payload.message || 'The agent could not answer.');
            setStage('ready');
          }
          if (event.type === 'done') setStage('complete');
        },
      });
    } catch (requestError) {
      if (requestError.name !== 'AbortError') setError(requestError.message);
      setStage('ready');
    }
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
              <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={240} />
              <small>The person, document, event, or object your adapter will evaluate.</small>
            </label>

            <label className="field">
              <span>Parameters</span>
              <textarea
                className="code-input"
                value={parameters}
                onChange={(event) => setParameters(event.target.value)}
                rows={7}
                spellCheck="false"
                aria-invalid={Boolean(parsedParameters.error)}
              />
              <small className={parsedParameters.error ? 'field-error' : ''}>
                {parsedParameters.error || 'Valid JSON is passed to your deterministic domain adapter.'}
              </small>
            </label>

            <button className="secondary-button" type="submit" disabled={busy || !subject.trim()}>
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
              <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={4000} />
            </label>

            <button className="primary-button" type="button" onClick={askAgent} disabled={busy || !question.trim()}>
              <PaperPlaneTilt size={19} weight="fill" aria-hidden="true" />
              {stage === 'streaming' ? 'Validating answer' : analysis ? 'Ask agent' : 'Prepare and continue'}
            </button>

            {busy && <div className="answer-skeleton" aria-label="Agent is working"><span /><span /><span /></div>}
            {error && <Status kind="error">{error}</Status>}
            {answer && (
              <article className="answer" aria-live="polite">
                <Status kind="success">Validated and settled</Status>
                <p>{answer}</p>
              </article>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
