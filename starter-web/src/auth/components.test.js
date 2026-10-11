import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthContext } from './useAuth.js';
import { AccountControl, AuthDialog } from './components.jsx';

function render(component, overrides = {}) {
  const auth = {
    enabled: true, config: { mode: 'self-hosted', enabled: true, capture: false },
    session: { user: null, session: null, profile: null }, sessionStatus: 'anonymous',
    open() {}, close() {}, registerDialogCancellation() { return () => {}; },
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(AuthContext.Provider, { value: auth }, component));
}

describe('account view contracts', () => {
  it('renders a named dialog with an explicit verification button and never renders its token', () => {
    const html = render(React.createElement(AuthDialog, { dialog: { id: 1, view: 'verify', token: 'never-render-this-token' } }));
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Verify my email');
    expect(html).toContain('Opening the link does not verify your account.');
    expect(html).not.toContain('never-render-this-token');
    expect(html).not.toContain('name="token"');
  });

  it('renders password-manager-friendly reset and confirmation fields, bounded to 12..128', () => {
    const html = render(React.createElement(AuthDialog, { dialog: { id: 1, view: 'reset', token: 'not-in-html' } }));
    expect(html.match(/type="password"/gu)).toHaveLength(2);
    expect(html.match(/autoComplete="new-password"/gu)).toHaveLength(2);
    expect(html.match(/minLength="12"/gu)).toHaveLength(2);
    expect(html.match(/maxLength="128"/gu)).toHaveLength(2);
    expect(html).toContain('Confirm new password');
    expect(html).not.toContain('not-in-html');
  });

  it('shows capture tools only when explicitly enabled by the public configuration', () => {
    const component = React.createElement(AuthDialog, { dialog: { id: 1, view: 'signin' } });
    expect(render(component)).not.toContain('Development inbox');
    expect(render(component, { config: { mode: 'self-hosted', enabled: true, capture: true } })).toContain('Development inbox');
  });

  it('leaves the existing Clerk product toolbar unchanged', () => {
    expect(render(React.createElement(AccountControl), { config: { mode: 'clerk', enabled: false }, enabled: false })).toBe('');
  });

  it('makes an expired session visible as an accessible error', () => {
    const html = render(React.createElement(AuthDialog, { dialog: { id: 1, view: 'account' } }), { sessionError: 'Your session has expired.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Your session has expired.');
    expect(html).toContain('Close account dialog');
  });
});
