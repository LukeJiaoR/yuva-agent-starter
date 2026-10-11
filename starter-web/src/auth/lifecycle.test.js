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

describe('mounted workspace identity boundaries', () => {
  it('clears private inputs, facts, and completed output on account change and reloads pricing', async () => {
    await renderWithAuth(account('A'));
    await change(container.querySelector('input'), 'Private A subject');
    await change(container.querySelector('.question-field textarea'), 'Private A question');
    await click('Prepare and continue');
    expect(container.textContent).toContain('Private A answer');
    expect(readPricing).toHaveBeenCalledTimes(1);

    await renderWithAuth(account('B'));
    expect(container.textContent).not.toContain('Private A');
    expect(container.querySelector('input').value).toBe('A customer renewal decision');
    expect(container.querySelector('.question-field textarea').value).not.toContain('Private A');
    expect(readPricing).toHaveBeenCalledTimes(2);
    expect(button('Prepare and continue').disabled).toBe(false);
  });

  it('does not reuse a former account pending request ID or inputs under the new account', async () => {
    streamChat.mockResolvedValue({ status: 'generating' });
    await renderWithAuth(account('A'));
    await change(container.querySelector('.question-field textarea'), 'Private A pending question');
    await click('Prepare and continue');
    const previous = streamChat.mock.calls[0][0];
    expect(button('Check result')).toBeDefined();

    await renderWithAuth(account('B'));
    await click('Prepare and continue');
    const next = streamChat.mock.calls[1][0];
    expect(next.requestId).not.toBe(previous.requestId);
    expect(next.question).not.toBe(previous.question);
  });

  it('aborts departed analysis and cannot start a stream when that analysis resolves late', async () => {
    const pending = deferred();
    analyzeInput.mockReturnValue(pending.promise); // Intentionally ignores abort.
    await renderWithAuth(account('A'));
    await click('Prepare and continue');
    const signal = analyzeInput.mock.calls[0][1];

    await renderWithAuth(account('B'));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ facts: { subject: 'Private A late facts' }, fingerprint: 'late' }));
    expect(streamChat).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Private A late facts');
  });

  it('ignores a departed stream even when its callbacks and completion arrive after abort', async () => {
    const pending = deferred();
    let callbacks;
    streamChat.mockImplementation((_payload, options) => { callbacks = options; return pending.promise; });
    await renderWithAuth(account('A'));
    await click('Prepare and continue');
    await renderWithAuth(account('B'));
    expect(callbacks.signal.aborted).toBe(true);
    await act(async () => {
      callbacks.onEvent({ type: 'text_delta', data: { text: 'Private A delayed stream' } });
      callbacks.onEvent({ type: 'done', data: { financial_status: 'settled', credits_used: 99 } });
      pending.resolve({ streamed: true });
    });
    expect(container.textContent).not.toContain('Private A delayed stream');
    expect(container.textContent).not.toContain('99 credits charged');
    expect(button('Prepare and continue').disabled).toBe(false);
  });

  it('recovers an initial pricing 401 after login without a page reload', async () => {
    readPricing.mockRejectedValueOnce(Object.assign(new Error('Expired session'), { status: 401 }));
    await renderWithAuth(account(null));
    expect(container.textContent).toContain('Pricing unavailable');
    expect(button('Prepare and continue').disabled).toBe(true);
    await renderWithAuth(account('A'));
    expect(readPricing).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Pricing unavailable');
    expect(button('Prepare and continue').disabled).toBe(false);
  });
});

describe('mounted account lifecycle', () => {
  it('replaces the previous account device list when a shared-cookie identity changes', async () => {
    const nextSessions = deferred();
    const first = { id: 'a-device', userAgent: 'Private A browser', current: false, createdAt: '2026-10-10', expiresAt: '2026-10-17' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ sessions: [first] })).mockReturnValueOnce(nextSessions.promise));
    const dialog = React.createElement(AuthDialog, { dialog: { id: 1, view: 'account' } });
    await renderWithAuth(account('A'), dialog);
    expect(container.textContent).toContain('Private A browser');
    await renderWithAuth(account('B'), dialog);
    expect(container.textContent).toContain('B@example.test');
    expect(container.textContent).not.toContain('Private A browser');
    await act(async () => nextSessions.resolve(response({ sessions: [{ ...first, id: 'b-device', userAgent: 'B browser' }] })));
    expect(container.textContent).toContain('B browser');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('synchronously locks duplicate submissions and never reopens a dismissed sign-in', async () => {
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const auth = account(null);
    await renderWithAuth(auth, React.createElement(AuthDialog, { dialog: { id: 1, view: 'signin' } }));
    await change(container.querySelector('input[name="email"]'), 'synthetic@example.test');
    await change(container.querySelector('input[name="password"]'), 'synthetic-password');
    await act(async () => {
      const form = container.querySelector('form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0][1].signal;
    await click('Cancel and close');
    expect(auth.close).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response({ status: true })));
    expect(fetch).toHaveBeenCalledTimes(1); // No late provision request.
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(auth.open).not.toHaveBeenCalled();
  });
});
