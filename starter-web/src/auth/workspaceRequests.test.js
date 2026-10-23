// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkspace } from '../main.jsx';
import { AuthContext } from './useAuth.js';
import { AuthDialog } from './components.jsx';
import { analyzeInput, checkReadiness, readPricing, streamChat } from '../api.js';

// The production entrypoint bootstraps #root. Tests mount its real exported
// workspace in their own container instead of creating a second application.
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createRoot: (container, options) => container
    ? actual.createRoot(container, options) : { render() {} } };
});
vi.mock('../api.js', () => ({
  analyzeInput: vi.fn(), checkReadiness: vi.fn(), readPricing: vi.fn(), streamChat: vi.fn(),
}));

const pricing = { strategy: 'fixed', credits: 2, authorizedCredits: 2 };
let root;
let container;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function account(id = 'A') {
  return {
    enabled: true, config: { mode: 'self-hosted', enabled: true, capture: false },
    configError: '', sessionStatus: id ? 'authenticated' : 'anonymous', sessionError: '',
    session: id ? { user: { id: `auth-${id}`, email: `${id}@example.test`, emailVerified: true }, profile: { id, display_name: `Account ${id}` }, session: { id: `session-${id}` } }
      : { user: null, profile: null, session: null },
    open: vi.fn(), close: vi.fn(), refreshSession: vi.fn().mockResolvedValue({ user: null }),
    registerDialogCancellation: () => () => {},
  };
}
async function renderWithAuth(auth, component = React.createElement(AccountWorkspace)) {
  await act(async () => root.render(React.createElement(AuthContext.Provider, { value: auth }, component)));
}
function button(text) {
  const match = [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}
async function click(text) {
  await act(async () => button(text).dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
async function change(node, value) {
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const response = (data) => ({ ok: true, status: 200, json: async () => data });

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
  localStorage.clear();
  [analyzeInput, checkReadiness, readPricing, streamChat].forEach((mock) => mock.mockReset());
  checkReadiness.mockResolvedValue({ status: 'ready' });
  readPricing.mockResolvedValue(pricing);
  analyzeInput.mockResolvedValue({ facts: { subject: 'Private A facts' }, fingerprint: 'private-a-fingerprint' });
  streamChat.mockImplementation(async (_payload, { onEvent }) => {
    onEvent({ type: 'text_delta', data: { text: 'Private A answer' } });
    onEvent({ type: 'done', data: { financial_status: 'settled', credits_used: 2 } });
    return { streamed: true };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('workspace request and input contracts (#89 S06/S07)', () => {
  it.each(['released', 'refunded'])('releases a known %s 409 snapshot and lets a new operation use a new ID', async (terminal) => {
    streamChat.mockRejectedValue(Object.assign(new Error('Request was released'), { status: 409, code: `request_${terminal}` }));
    await renderWithAuth(account('A'));
    await click('Prepare and continue');
    const id = streamChat.mock.calls[0][0].requestId;
    expect(button('Preview facts').disabled).toBe(false);
    expect(container.textContent).not.toContain('Check result');
    await click('Ask agent');
    expect(streamChat.mock.calls[1][0].requestId).not.toBe(id);
  });
  it.each(['released', 'refunded'])('clears a terminal %s SSE error snapshot', async (terminal) => {
    streamChat.mockImplementation(async (_payload, { onEvent }) => {
      onEvent({ type: 'error', data: { code: `request_${terminal}`, financial_status: terminal, message: 'Operation ended' } });
      return { streamed: true };
    });
    await renderWithAuth(account('A'));
    await click('Prepare and continue');
    expect(button('Preview facts').disabled).toBe(false);
    expect(container.textContent).not.toContain('Check result');
    expect(container.querySelector('input').disabled).toBe(false);
  });
  it.each([409, 500])('retains the same request and locks inputs after unknown status %s', async (status) => {
    streamChat.mockRejectedValue(Object.assign(new Error('Unknown execution'), { status, code: 'execution_unknown' }));
    await renderWithAuth(account('A'));
    await click('Prepare and continue');
    const input = structuredClone(streamChat.mock.calls[0][0]);
    expect(container.querySelector('input').disabled).toBe(true);
    expect(container.querySelector('textarea.code-input').disabled).toBe(true);
    expect(button('Preview facts').disabled).toBe(true);
    await click('Check result');
    expect(streamChat.mock.calls[1][0]).toEqual(input);
    expect(container.textContent).toContain('Inputs are locked');
  });
  it.each(['reconciliation', 'network', 'pending_disconnect'])('keeps request identity for %s uncertainty', async (kind) => {
    streamChat.mockImplementation(async (_payload, { onEvent }) => {
      if (kind === 'reconciliation') throw Object.assign(new Error('Checking outcome'), {
        status: 409, code: 'request_reconciliation_required', financialStatus: 'reconciliation_required',
      });
      if (kind === 'pending_disconnect') onEvent({ type: 'pending', data: { status: 'reserved' } });
      throw new TypeError('Connection interrupted');
    });
    await renderWithAuth(account('A'));
    await click('Prepare and continue');
    const original = structuredClone(streamChat.mock.calls[0][0]);
    expect(container.querySelector('input').disabled).toBe(true);
    await click('Check result');
    expect(streamChat.mock.calls[1][0]).toEqual(original);
  });
  it('invalidates edited facts and recomputes them before submitting the matching input', async () => {
    await renderWithAuth(account('A'));
    await act(async () => container.querySelector('form.input-panel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await change(container.querySelector('input'), 'CHANGED SUBJECT');
    expect(container.textContent).not.toContain('Private A facts');
    analyzeInput.mockResolvedValue({ facts: { subject: 'CHANGED SUBJECT' }, fingerprint: 'changed' });
    await click('Prepare and continue');
    expect(analyzeInput).toHaveBeenCalledTimes(2);
    expect(streamChat.mock.calls[0][0].subject).toBe('CHANGED SUBJECT');
    expect(container.textContent).toContain('CHANGED SUBJECT');
  });
  it('refuses invalid JSON even after a valid preview', async () => {
    await renderWithAuth(account('A'));
    await act(async () => container.querySelector('form.input-panel').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await change(container.querySelector('textarea.code-input'), '{broken json');
    await click('Prepare and continue');
    expect(streamChat).not.toHaveBeenCalled();
    expect(analyzeInput).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Parameters must be valid JSON.');
  });
  it('synchronously prevents rapid duplicate submissions while analysis is unresolved', async () => {
    const pending = deferred(); analyzeInput.mockReturnValue(pending.promise);
    await renderWithAuth(account('A'));
    const trigger = button('Prepare and continue');
    await act(async () => { trigger.click(); trigger.click(); });
    expect(analyzeInput).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ facts: { subject: 'facts' }, fingerprint: 'f' }));
    expect(streamChat).toHaveBeenCalledTimes(1);
  });
});
