import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import * as context from '../index.js';

describe('complete conversation context public contract', () => {
  it('supports native ESM named imports from the package root', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { assembleConversationContext, loadConversationMessages } from '@yuva/context-engine'; if (typeof assembleConversationContext !== 'function' || typeof loadConversationMessages !== 'function') process.exit(1);"],
    { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('retains the complete chart and oldest history despite budget or priority hints', () => {
    const chart = 'chart '.repeat(260001);
    const units = [
      { key: 'chart', category: 'chart', text: chart, priority: -100 },
      { key: 'history', channel: 'message', text: 'earliest fact', payload: { role: 'user', content: 'earliest fact' } },
      { key: 'answer', channel: 'message', text: 'earliest answer', payload: { role: 'assistant', content: 'earliest answer' } },
      { key: 'question', channel: 'message', text: 'current question' },
    ];
    const result = context.assembleConversationContext({ units, budgetTokens: 1, tokenCounter: text => text.length });
    expect(result.systemPrompt).toBe(chart);
    expect(result.messages).toEqual([
      { role: 'user', content: 'earliest fact' },
      { role: 'assistant', content: 'earliest answer' },
      { role: 'user', content: 'current question' },
    ]);
    expect(result.diagnostics).toMatchObject({ policy: 'complete', budget_tokens: null,
      omitted: [], omitted_tokens: 0, capacity_authority: 'provider' });
    expect(result.diagnostics.included.map(unit => unit.key)).toEqual(units.map(unit => unit.key));
    expect(result.usedTokens).toBe(units.reduce((sum, unit) => sum + unit.text.length, 0));
    expect(units[0]).not.toHaveProperty('requestedTokens');
  });

  it('preserves multiple system units and message payload arrays in supplied order', () => {
    const result = context.assembleConversationContext({ units: [
      null, { key: 'safety', text: 'safety' },
      { key: 'history', channel: 'message', text: 'history', payload: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: 'second' },
      ] }, { key: 'facts', text: 'facts' },
    ] });
    expect(result.systemPrompt).toBe('safety\nfacts');
    expect(result.messages.map(message => message.content)).toEqual(['first', 'second']);
    expect(result.diagnostics.omitted).toEqual([]);
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid diagnostic count %s', count => {
    expect(() => context.assembleConversationContext({ units: [{ text: 'fact' }], tokenCounter: () => count }))
      .toThrow('Invalid diagnostic text count');
  });

  it('loads every page oldest first and forwards the requested page size', async () => {
    const pages = [
      { messages: [{ id: '1', content: 'earliest' }], nextCursor: { id: '1' } },
      { messages: [{ id: '2', content: 'middle' }], nextCursor: { id: '2' } },
      { messages: [{ id: '3', content: 'latest' }], nextCursor: null },
    ];
    const readPage = vi.fn(async () => pages.shift());
    expect((await context.loadConversationMessages({ readPage, pageSize: 2 })).map(message => message.id))
      .toEqual(['1', '2', '3']);
    expect(readPage.mock.calls.map(([args]) => args)).toEqual([
      { cursor: null, limit: 2 }, { cursor: { id: '1' }, limit: 2 }, { cursor: { id: '2' }, limit: 2 },
    ]);
  });

  it('propagates a later storage failure instead of returning truncated history', async () => {
    const failure = new Error('authorized history storage failed');
    const readPage = vi.fn().mockResolvedValueOnce({ messages: [{ id: 'earliest' }], nextCursor: 'earliest' })
      .mockRejectedValueOnce(failure);
    await expect(context.loadConversationMessages({ readPage })).rejects.toBe(failure);
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { messages: 'invalid' }])('rejects malformed storage pages %j', page => {
    return expect(context.loadConversationMessages({ readPage: async () => page })).rejects.toThrow('Invalid conversation page');
  });

  it('rejects repeated cursors and empty continuation pages instead of looping', async () => {
    await expect(context.loadConversationMessages({ readPage: async () => ({ messages: [{ id: '1' }], nextCursor: '1' }) }))
      .rejects.toThrow('did not advance');
    await expect(context.loadConversationMessages({ readPage: async () => ({ messages: [], nextCursor: '1' }) }))
      .rejects.toThrow('did not advance');
  });
});
