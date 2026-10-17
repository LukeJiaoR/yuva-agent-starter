import React, { useEffect, useState } from 'react';
import { useAuth } from '../auth/useAuth.js';
import { FINANCIAL_STATUSES, MAX_OFFSET, PAGE_SIZE, historyError, historyQuery, isOperationId, readCapabilities, readOperation, readOperations } from './api.js';
import { age, costLabel, count, date, metricLabels, source, text } from './format.js';
import './operations.css';

// Keyed resources hide old data during the render that changes identity/query,
// before effect cleanup runs. Abort plus ownership checks discard late replies.
function useRead(key, read) {
  const [result, setResult] = useState({ key: null, state: 'loading' });
  useEffect(() => {
    if (key === null) return undefined;
    const controller = new AbortController();
    let current = true;
    setResult({ key, state: 'loading' });
    Promise.resolve().then(() => read(controller.signal)).then(
      (data) => { if (current && !controller.signal.aborted) setResult({ key, state: 'ready', data }); },
      (error) => { if (current && !controller.signal.aborted) setResult({ key, state: 'error', error }); },
    );
    return () => { current = false; controller.abort(); };
  }, [key]); // A key fully identifies the read, including all filter values.
  return result.key === key ? result : { state: 'loading' };
}
function Fields({ entries }) {
  return <dl className="history-fields">{entries.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
}
function Truncated({ value }) { return value ? <p className="history-note">Only the first records are shown. This section is truncated.</p> : null; }
function Summary({ operation: op, operator }) {
  return <Fields entries={[
    ['Operation ID', text(op.operationId)], ...(operator ? [['Account ID', text(op.accountId)]] : []),
    ['Task', text(op.taskType)], ['Execution', text(op.executionStatus)], ['Financial', text(op.financialStatus)], ['Fulfillment', text(op.fulfillmentStatus)],
    ['Reconciliation reason', text(op.reconciliationReason)], ['Created', date(op.createdAt)], ['Updated', date(op.updatedAt)], ['Pending age', age(op.pendingAgeSeconds)], ['Manual review', op.manualReview === true ? 'Required' : op.manualReview === false ? 'Not flagged' : 'Unknown'],
  ]} />;
}
export function OperationDetail({ data, operator = false }) {
  const quote = data.quote || {};
  const recovery = data.recovery || {};
  const request = data.ledger?.request;
  return <article aria-label="Operation details">
    <h3>Operation details</h3>
    <Summary operation={data.operation || {}} operator={operator} />
    <h4>Frozen quote</h4>
    <Fields entries={[
      ['Policy', text(quote.policyId)], ['Policy version', text(quote.policyVersion)], ['Unit', text(quote.unit)], ['Reserved quote', count(quote.reserveCredits)], ['Authorized maximum', count(quote.authorizedCredits)],
    ]} />
    <h4>Provider binding</h4>
    {quote.providerBinding?.items?.length ? <ul>{quote.providerBinding.items.map((binding, index) => <li key={index}>{text(binding.provider)} · {text(binding.model)}</li>)}</ul> : <p>No provider binding recorded.</p>}
    <Truncated value={quote.providerBinding?.truncated} />
    <h4>Provider calls and usage</h4>
    {data.calls?.items?.length ? data.calls.items.map((call) => <section className="history-record" key={call.callId} aria-label="Provider call">
      <Fields entries={[
        ['Call ID', text(call.callId)], ['Attempt', count(call.attempt)], ['Provider', text(call.provider)], ['Model', text(call.model)], ['Outcome', text(call.outcome)], ['External status', text(call.externalStatus)], ['Failure code', text(call.failureCode)], ['Cost', costLabel(call.cost)], ['Duration (ms)', count(call.durationMs)], ['Started', date(call.startedAt)], ['Observed', date(call.observedAt)],
      ]} />
      <Fields entries={Object.entries(metricLabels).filter(([name]) => call.metrics?.[name]).map(([name, label]) => [label, `${count(call.metrics[name].value)} · ${source(call.metrics[name].source)}`])} />
    </section>) : <p>No provider calls recorded.</p>}
    <Truncated value={data.calls?.truncated} />
    <h4>Artifact references</h4>
    {data.artifacts?.items?.length ? data.artifacts.items.map((artifact) => <section className="history-record" key={artifact.artifactId}>
      <Fields entries={[
        ['Artifact ID', text(artifact.artifactId)], ['Type', text(artifact.type)], ['State', text(artifact.state)], ['MIME type', text(artifact.mimeType)], ['Bytes', count(artifact.byteSize)],
      ]} />
    </section>) : <p>No artifact references recorded.</p>}
    <Truncated value={data.artifacts?.truncated} />
    <h4>Credit ledger</h4>
    {request ? <Fields entries={[
      ['Request ID', text(request.requestId)], ['Status', text(request.status)], ['Reserved credits', count(request.reservedCredits)], ['Settled credits', count(request.settledCredits)], ['Released credits', count(request.releasedCredits)], ['Started', date(request.startedAt)], ['Completed', date(request.completedAt)],
    ]} /> : <p>No ledger request recorded.</p>}
    {data.ledger?.transactions?.items?.length ? <ol>{data.ledger.transactions.items.map((entry) => <li className="history-record" key={entry.transactionId}>
      <Fields entries={[
        ['Transaction ID', text(entry.transactionId)], ['Type', text(entry.type)], ['Direction', text(entry.direction)], ['Credits', count(entry.amount)], ['Status', text(entry.status)], ['Created', date(entry.createdAt)],
      ]} />
    </li>)}</ol> : <p>No ledger transactions recorded.</p>}
    <Truncated value={data.ledger?.transactions?.truncated} />
    <h4>Recovery timeline</h4>
    <Fields entries={[
      ['Attempts', count(recovery.attempts)], ['Review', recovery.manualReview === true ? 'Manual review required' : recovery.manualReview === false ? 'Not flagged' : 'Unknown'], ['Reason', text(recovery.reason)], ['Next recovery', date(recovery.nextRecoveryAt)], ['Deadline', date(recovery.deadlineAt)], ['Lease expires', date(recovery.leaseExpiresAt)], ['Overdue', recovery.overdue === true ? 'Yes' : recovery.overdue === false ? 'No' : 'Unknown'],
    ]} />
    {recovery.events?.items?.length ? <ol>{recovery.events.items.map((event) => <li className="history-record" key={event.eventId}>
      <Fields entries={[
        ['Event ID', text(event.eventId)], ['Action', text(event.action)], ['Reason', text(event.reason)], ['Time', date(event.createdAt)],
      ]} />
    </li>)}</ol> : <p>No recovery events recorded.</p>}
    <Truncated value={recovery.events?.truncated} />
    <h4>Administrative audit timeline</h4>
    {data.audits?.items?.length ? <ol>{data.audits.items.map((audit) => <li className="history-record" key={audit.auditId}>
      <Fields entries={[
        ['Audit ID', text(audit.auditId)], ['Action', text(audit.action)], ['Status', text(audit.status)], ['Error code', text(audit.errorCode)], ['Created', date(audit.createdAt)], ['Finished', date(audit.finishedAt)],
      ]} />
    </li>)}</ol> : <p>No administrative audit events recorded.</p>}
    <Truncated value={data.audits?.truncated} />
    <p className="history-note">Payment-event history is not available in this view. Credit ledger entries are not payment receipts.</p>
  </article>;
}
function Detail({ operationId, operator }) {
  const result = useRead(`${operator}:${operationId}`, (signal) => readOperation(operationId, operator, signal));
  if (result.state === 'loading') return <p role="status">Loading operation…</p>;
  if (result.state === 'error') return <p role="alert">{historyError(result.error)}</p>;
  return <OperationDetail data={result.data} operator={operator} />;
}
function HistoryList({ operator }) {
  const [filters, setFilters] = useState({ accountId: '', status: '' });
  const [draft, setDraft] = useState(filters);
  const [filterError, setFilterError] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [operationInput, setOperationInput] = useState('');
  const [operationError, setOperationError] = useState('');
  const [revision, setRevision] = useState(0);
  const options = { operator, ...filters, offset, limit: PAGE_SIZE };
  const result = useRead(`${historyQuery(options)}:${operator}:${revision}`, (signal) => readOperations(options, signal));
  function apply(event) {
    event.preventDefault();
    const candidate = { accountId: draft.accountId.trim(), status: draft.status };
    try { historyQuery({ operator, ...candidate }); }
    catch { setFilterError('Enter a valid account UUID and choose a listed status.'); return; }
    setFilterError(''); setSelected(null); setOffset(0); setFilters(candidate); setRevision((value) => value + 1);
  }
  function openOperation(event) {
    event.preventDefault();
    setSelected(null);
    const id = operationInput.trim();
    if (!isOperationId(id)) { setOperationError('Enter a valid operation UUID.'); return; }
    setOperationError(''); setSelected(id); setDetailRevision((value) => value + 1);
  }
  function page(value) { setSelected(null); setOffset(value); }
  const next = result.data?.page?.nextOffset;
  const canNext = result.state === 'ready' && result.data?.page?.hasMore === true && Number.isInteger(next) && next > offset && next <= MAX_OFFSET;
  return <>
    <form className="history-filters" aria-label="Find operation" onSubmit={openOperation}>
      <label className="field"><span>Operation UUID</span><input aria-label="Operation UUID" value={operationInput} maxLength={36} onChange={(event) => setOperationInput(event.target.value)} /></label>
      <button className="secondary-button" type="submit">Open operation</button>
      {operationError && <p role="alert">{operationError}</p>}
    </form>
    {operator && <form className="history-filters" aria-label="Filter accounts" onSubmit={apply}>
      <label className="field"><span>Account UUID (optional)</span><input aria-label="Account UUID" value={draft.accountId} maxLength={36} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })} /></label>
      <label className="field"><span>Financial status</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">All statuses</option>{FINANCIAL_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
      <button className="secondary-button" type="submit">Apply filters</button>
      {filterError && <p role="alert">{filterError}</p>}
    </form>}
    <button className="secondary-button" type="button" onClick={() => { setSelected(null); setRevision((value) => value + 1); }}>Refresh history</button>
    {result.state === 'loading' && <p role="status">Loading history…</p>}
    {result.state === 'error' && <p role="alert">{historyError(result.error)}</p>}
    {result.state === 'ready' && <>
      {result.data.items?.length ? <ul className="history-list">{result.data.items.map((op) => <li key={op.operationId}>
        <button type="button" className="history-operation" aria-pressed={selected === op.operationId} onClick={() => setSelected(op.operationId)}>
          <strong>{text(op.operationId)}</strong><span>{text(op.taskType)} · {text(op.executionStatus)} · {text(op.financialStatus)}</span><span>Created: {date(op.createdAt)} · Pending age: {age(op.pendingAgeSeconds)}</span>
        </button>
      </li>)}</ul> : <p>No operations found{operator ? ' for these filters' : ' for your account'}.</p>}
      <nav className="history-pagination" aria-label="History pages">
        <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => page(Math.max(0, offset - PAGE_SIZE))}>Previous page</button>
        <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
        <button type="button" className="secondary-button" disabled={!canNext} onClick={() => page(next)}>Next page</button>
      </nav>
      {result.data.page?.hasMore && !canNext && <p className="history-note">The browsing limit has been reached. Narrow the operator filters if available.</p>}
    </>}
    {selected && <Detail key={`${operator}:${selected}:${detailRevision}`} operationId={selected} operator={operator} />}
  </>;
}
function AuthorizedHistory() {
  const capabilities = useRead('capabilities', readCapabilities);
  const [operator, setOperator] = useState(false);
  if (capabilities.state === 'loading') return <p role="status">Checking history availability…</p>;
  if (capabilities.state === 'error') return capabilities.error.status === 404
    ? <p role="status">Operation history is not enabled.</p> : <p role="alert">{historyError(capabilities.error)}</p>;
  if (capabilities.data?.enabled !== true || capabilities.data?.selfRead !== true) return <p role="status">Operation history is not enabled.</p>;
  const canOperate = capabilities.data.operatorRead === true;
  return <>
    <nav className="history-modes" aria-label="History scope">
      <button type="button" className="secondary-button" aria-pressed={!operator} onClick={() => setOperator(false)}>My operations</button>
      {canOperate && <button type="button" className="secondary-button" aria-pressed={operator} onClick={() => setOperator(true)}>Operator view</button>}
    </nav>
    <p>{operator && canOperate ? 'Operator view: read-only account history.' : 'Your account’s operation history.'} Charges may remain provisional while an operation is pending.</p>
    <HistoryList key={operator && canOperate ? 'operator' : 'self'} operator={operator && canOperate} />
  </>;
}
export function OperationHistory() {
  const auth = useAuth();
  const identity = auth.session?.user?.id;
  const profile = auth.session?.profile?.id;
  if (auth.sessionStatus !== 'authenticated' || !identity) return <section className="operation-history"><h2>Operation history</h2><p>Sign in to view your operation history.</p></section>;
  return <section className="operation-history" aria-label="Operation history"><h2>Operation history</h2><AuthorizedHistory key={`${identity}:${profile || ''}:${auth.session?.session?.id || ''}`} /></section>;
}
