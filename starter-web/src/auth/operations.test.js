// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext } from './useAuth.js';
import { OperationDetail, OperationHistory } from '../operations/OperationHistory.jsx';
import { historyQuery, readOperation, readOperations } from '../operations/api.js';
import { age, costLabel } from '../operations/format.js';

let container, root;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const capabilities = (operatorRead = false) => response({ enabled: true, selfRead: true, operatorRead });
const operation = (id = '6d46e0ad-6a16-4d35-aa50-62221116990c') => ({ operationId: id, taskType: 'chat', executionStatus: 'completed', financialStatus: 'settled', fulfillmentStatus: 'fulfilled', createdAt: '2026-10-15T08:00:00Z', pendingAgeSeconds: null });
const list = (id = '6d46e0ad-6a16-4d35-aa50-62221116990c', page = {}) => response({ items: id ? [operation(id)] : [], page: { offset: 0, limit: 20, hasMore: false, nextOffset: null, ...page } });
const accountId = '7e155dfd-329c-4b99-8f84-96d33056f211';
function auth(id = 'A', extra = {}) { return { sessionStatus: id ? 'authenticated' : 'anonymous', session: { user: id ? { id, role: 'operator' } : null, profile: id ? { id: `profile-${id}` } : null, session: { id: `session-${id}` } }, ...extra }; }
async function render(id = 'A', extra) { await act(async () => root.render(React.createElement(AuthContext.Provider, { value: auth(id, extra) }, React.createElement(OperationHistory)))); }
function button(label) { const node = [...container.querySelectorAll('button')].find((el) => el.textContent === label); if (!node) throw new Error(`Missing button: ${label}`); return node; }
async function click(label) { await act(async () => button(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function selectOperation(id = '6d46e0ad-6a16-4d35-aa50-62221116990c') { await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent.includes(id)).dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function input(node, value) { await act(async () => { const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
async function submit() { await act(async () => container.querySelector('[aria-label="Filter accounts"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.stubGlobal('fetch', vi.fn()); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

describe('read-only operation history', () => {
  it('does not fetch while anonymous or auth is loading', async () => {
    await render(null); expect(container.textContent).toContain('Sign in'); expect(fetch).not.toHaveBeenCalled();
    await render('A', { sessionStatus: 'loading' }); expect(fetch).not.toHaveBeenCalled();
  });
  it('handles disabled404 without claiming empty history or exposing response content', async () => {
    fetch.mockResolvedValue(response({ error: 'PRIVATE backend detail' }, 404)); await render();
    expect(container.textContent).toContain('not enabled'); expect(container.textContent).not.toMatch(/No operations|PRIVATE/); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[401, 'session has expired'], [403, 'permission'], [500, 'could not be loaded']])('shows safe capability error for%s', async (status, expected) => {
    fetch.mockResolvedValue(response({ error: 'SECRET' }, status)); await render(); expect(container.querySelector('[role="alert"]').textContent).toContain(expected); expect(container.textContent).not.toContain('SECRET');
  });
  it('ignores local roles and URL hints; self reads have no account or status filter and use onlyGET', async () => {
    window.history.replaceState({}, '', '/?role=operator&accountId=other');
    fetch.mockResolvedValueOnce(capabilities(false)).mockResolvedValueOnce(list()); await render();
    expect(container.textContent).not.toContain('Operator view'); expect(container.querySelector('[aria-label="Account UUID"]')).toBeNull();
    expect(fetch.mock.calls[1][0]).toBe('/api/operations?limit=20&offset=0');
    for (const [, options] of fetch.mock.calls) { expect(options.method).toBe('GET'); expect(options.body).toBeUndefined(); expect(options.credentials).toBe('include'); expect(options.cache).toBe('no-store'); }
    expect(container.textContent).not.toMatch(/refund|retry|credit adjustment/i);
    window.history.replaceState({}, '', '/');
  });
  it('distinguishes a successful empty list from an unavailable list', async () => {
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(list(null)); await render(); expect(container.textContent).toContain('No operations found for your account');
    fetch.mockResolvedValueOnce(response({}, 404)); await click('Refresh history'); expect(container.textContent).toContain('History is unavailable'); expect(container.textContent).not.toContain('No operations');
  });
  it('shows loading, bounded pagination and clears details on page change', async () => {
    const pending = deferred(); fetch.mockResolvedValueOnce(capabilities()).mockReturnValueOnce(pending.promise); await render(); expect(container.textContent).toContain('Loading history');
    await act(async () => pending.resolve(list('6d46e0ad-6a16-4d35-aa50-62221116990c', { hasMore: true, nextOffset: 20 })));
    expect(button('Previous page').disabled).toBe(true); expect(button('Next page').disabled).toBe(false);
    fetch.mockResolvedValueOnce(response({ operation: operation(), quote: { policyId: 'private-quote' } })); await selectOperation(); expect(container.textContent).toContain('private-quote');
    fetch.mockResolvedValueOnce(list('d794af5d-9a32-4788-bbc4-7ff2a0ee5211', { offset: 20, hasMore: true, nextOffset: 10020 })); await click('Next page');
    expect(fetch.mock.calls.at(-1)[0]).toBe('/api/operations?limit=20&offset=20'); expect(container.textContent).not.toContain('private-quote'); expect(button('Next page').disabled).toBe(true); expect(button('Previous page').disabled).toBe(false);
  });
  it('allows only server-capable operator filters and rejects malformed filters before requests', async () => {
    fetch.mockResolvedValueOnce(capabilities(true)).mockResolvedValueOnce(list()); await render();
    fetch.mockResolvedValueOnce(list()); await click('Operator view'); expect(fetch.mock.calls.at(-1)[0]).toBe('/api/ops/operations?limit=20&offset=0');
    await input(container.querySelector('[aria-label="Account UUID"]'), 'not-an-account'); const calls = fetch.mock.calls.length; await submit(); expect(fetch).toHaveBeenCalledTimes(calls); expect(container.textContent).toContain('valid account UUID');
    await input(container.querySelector('[aria-label="Account UUID"]'), accountId); await input(container.querySelector('select'), 'reserved'); fetch.mockResolvedValueOnce(list(null)); await submit();
    expect(fetch.mock.calls.at(-1)[0]).toBe(`/api/ops/operations?limit=20&offset=0&accountId=${accountId}&status=reserved`);
    fetch.mockResolvedValueOnce(list()); await click('My operations'); expect(container.querySelector('[aria-label="Account UUID"]')).toBeNull(); expect(fetch.mock.calls.at(-1)[0]).toBe('/api/operations?limit=20&offset=0');
  });
  it('opens a known operation UUID directly in self scope and validates before reading', async () => {
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(list(null)); await render();
    const field = container.querySelector('[aria-label="Operation UUID"]');
    await input(field, '../other-account');
    await act(async () => container.querySelector('[aria-label="Find operation"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fetch).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('valid operation UUID');
    const id = '6d46e0ad-6a16-4d35-aa50-62221116990c'; await input(field, id);
    fetch.mockResolvedValueOnce(response({ operation: operation(id) }));
    await act(async () => container.querySelector('[aria-label="Find operation"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fetch.mock.calls.at(-1)[0]).toBe(`/api/operations/${id}`); expect(fetch.mock.calls.at(-1)[1].method).toBe('GET');
    expect(container.textContent).toContain('Operation details');
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(list(null)); await render('B');
    expect(container.querySelector('[aria-label="Operation UUID"]').value).toBe(''); expect(container.textContent).not.toContain('Operation details');
  });
  it('shows operator403 and never falls back to a different account route', async () => {
    fetch.mockResolvedValueOnce(capabilities(true)).mockResolvedValueOnce(list()); await render(); fetch.mockResolvedValueOnce(response({}, 403)); await click('Operator view');
    expect(container.textContent).toContain('permission'); expect(fetch).toHaveBeenCalledTimes(3); expect(container.textContent).not.toContain('6d46e0ad-6a16-4d35-aa50-62221116990c');
  });
  it('discards stale lists and capabilities across account switches and logout', async () => {
    const pending = deferred(); fetch.mockResolvedValueOnce(capabilities(true)).mockReturnValueOnce(pending.promise); await render('A'); const oldSignal = fetch.mock.calls[1][1].signal;
    fetch.mockResolvedValueOnce(capabilities(false)).mockResolvedValueOnce(list('operation-B')); await render('B'); expect(oldSignal.aborted).toBe(true);
    await act(async () => pending.resolve(list('PRIVATE-operation-A'))); expect(container.textContent).toContain('operation-B'); expect(container.textContent).not.toMatch(/PRIVATE|Operator view/);
    await render(null); expect(container.textContent).not.toContain('operation-B'); expect(container.textContent).toContain('Sign in');
  });
  it('never accepts a late capability grant from the previous account', async () => {
    const pending = deferred(); fetch.mockReturnValueOnce(pending.promise); await render('A'); const oldSignal = fetch.mock.calls[0][1].signal;
    fetch.mockResolvedValueOnce(capabilities(false)).mockResolvedValueOnce(list('operation-B')); await render('B');
    await act(async () => pending.resolve(capabilities(true)));
    expect(oldSignal.aborted).toBe(true); expect(container.textContent).not.toContain('Operator view'); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('clears loaded private details before the next account capabilities return', async () => {
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(list()); await render('A');
    fetch.mockResolvedValueOnce(response({ operation: operation(), quote: { policyId: 'PRIVATE-A-policy' } })); await selectOperation(); expect(container.textContent).toContain('PRIVATE-A-policy');
    fetch.mockReturnValueOnce(new Promise(() => {})); await render('B'); expect(container.textContent).not.toContain('PRIVATE-A-policy'); expect(container.textContent).toContain('Checking history availability');
  });
  it('discards stale detail and scrubs previous details immediately on account switch', async () => {
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(list()); await render('A');
    const pending = deferred(); fetch.mockReturnValueOnce(pending.promise); await selectOperation(); const oldSignal = fetch.mock.calls.at(-1)[1].signal;
    fetch.mockResolvedValueOnce(capabilities()).mockResolvedValueOnce(list('operation-B')); await render('B');
    await act(async () => pending.resolve(response({ operation: operation('PRIVATE-A'), quote: { policyId: 'PRIVATE-policy' } })));
    expect(oldSignal.aborted).toBe(true); expect(container.textContent).not.toContain('PRIVATE');
  });
  it('discards late old-filter lists and clears account search on self switch', async () => {
    fetch.mockResolvedValueOnce(capabilities(true)).mockResolvedValueOnce(list()); await render(); fetch.mockResolvedValueOnce(list()); await click('Operator view');
    const pending = deferred(); await input(container.querySelector('[aria-label="Account UUID"]'), accountId); fetch.mockReturnValueOnce(pending.promise); await submit(); const signal = fetch.mock.calls.at(-1)[1].signal;
    fetch.mockResolvedValueOnce(list('self-op')); await click('My operations'); await act(async () => pending.resolve(list('PRIVATE-other-account')));
    expect(signal.aborted).toBe(true); expect(container.textContent).not.toContain('PRIVATE'); expect(container.querySelector('[aria-label="Account UUID"]')).toBeNull();
  });
});

describe('history formatting and request validation', () => {
  it('does not label a missing pending age as a terminal operation', () => {
    expect(age(null)).toBe('Not pending'); expect(age(undefined)).toBe('Unknown'); expect(age(0)).toBe('0 seconds (at last read)');
  });
  it('distinguishes unknown, exact knownzero, estimate and provider costs without combining currencies', () => {
    expect(costLabel(null)).toBe('Unknown cost · Missing');
    expect(costLabel({ amount: '0', scale: 6, currency: 'USD', source: 'provider', status: 'observed' })).toBe('0.000000 USD · Provider reported · Observed');
    expect(costLabel({ amount: '123', scale: 2, currency: 'EUR', source: 'estimate', status: 'estimated' })).toBe('1.23 EUR · Estimated · Estimated');
    expect(costLabel({ amount: '9007199254740993123', scale: 2, currency: 'USD', source: 'synthetic', status: 'reconciled' })).toBe('90071992547409931.23 USD · Synthetic · Reconciled');
    expect(costLabel({ amount: '0', scale: 2, currency: null })).toBe('Unknown cost');
    expect(costLabel({ amount: '100', scale: 2, currency: 'USDC', source: 'provider', status: 'observed' })).toBe('1.00 USDC · Provider reported · Observed');
  });
  it('renders allowlisted fields, safely escapes markup and never renders raw request/output/metadata', () => {
    const html = renderToStaticMarkup(React.createElement(OperationDetail, { data: {
      operation: { ...operation('<script>alert(1)</script>'), accountId: 'PRIVATE-account', reconciliationReason: 'submission_unknown', prompt: 'SECRET-prompt', metadata: { key: 'SECRET-key' } },
      quote: { policyId: 'fixed-v1', reserveCredits: 0, authorizedCredits: 2, providerBinding: { items: [{ provider: 'openai', model: 'safe-model', apiKey: 'SECRET-api' }] } },
      calls: { items: [{ callId: 'call-1', failureCode: 'provider_timeout', provider: 'openai', model: 'safe-model', raw: 'SECRET-raw', metrics: { inputTokens: { value: null, source: 'missing' }, outputTokens: { value: 0, source: 'provider' }, arbitrary: { value: 'SECRET-metric' } }, cost: { amount: '0', scale: 2, currency: 'USD', source: 'provider', status: 'observed' } }], truncated: true },
      artifacts: { items: [{ artifactId: 'artifact-1', url: 'https://SECRET-signed-url', body: 'SECRET-body' }] },
      audits: { items: [{ auditId: 'audit-1', action: 'operation_audit', status: 'failed', errorCode: 'artifact_transfer_failed', metadata: 'SECRET-audit' }], truncated: false },
      ledger: { request: { reservedCredits: 0, settledCredits: null }, transactions: { items: [] } }, recovery: { events: { items: [] } },
    } }));
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('SECRET'); expect(html).not.toContain('PRIVATE-account');
    expect(html).toContain('Unknown · Missing'); expect(html).toContain('0 · Provider reported'); expect(html).toContain('0.00 USD'); expect(html).toContain('truncated'); expect(html).toContain('safe-model'); expect(html).toContain('artifact-1');
    expect(html).not.toContain('<a '); expect(html).toContain('submission_unknown'); expect(html).toContain('provider_timeout'); expect(html).toContain('audit-1'); expect(html).toContain('artifact_transfer_failed');
  });
  it('validates bounds, statuses and self/account scope before network access', async () => {
    for (const options of [{ offset: -1 }, { offset: 10001 }, { offset: 0.5 }, { limit: 51 }, { limit: 0 }, { accountId }, { status: 'reserved' }, { operator: true, status: 'rogue' }, { operator: true, accountId: 'x' }]) expect(() => historyQuery(options)).toThrow();
    expect(() => readOperations({ accountId })).toThrow(); expect(() => readOperation('../other', false)).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
