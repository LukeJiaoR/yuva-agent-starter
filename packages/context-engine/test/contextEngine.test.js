import { describe, it, expect } from 'vitest';
import {
  allocateContextBudget,
  planContextBudget,
  resolveContextBudget,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_CONTEXT_MIN_BUDGET_TOKENS,
  DEFAULT_CONTEXT_MAX_BUDGET_TOKENS,
  DEFAULT_CONTEXT_PRIORITIES,
} from '../index.js';

describe('@yuva/context-engine', () => {
  describe('contextBudget', () => {
    it('allocates context units based on priorities and respects token limits', () => {
      const units = [
        { key: 'system.prompt', category: 'safety', required: true, text: 'Safety instructions', channel: 'system', priority: 1000 },
        { key: 'memory.prefs', category: 'memory', required: false, text: 'User likes short answers', channel: 'system', priority: 400 },
        { key: 'history.recent', category: 'history', required: false, text: 'Past conversation messages', channel: 'message', priority: 200 },
      ];

      const result = allocateContextBudget({
        units,
        budgetTokens: 50,
        tokenCounter: (text) => text.split(' ').length,
      });

      expect(result.usedTokens).toBeGreaterThan(0);
      expect(result.systemUnits.length).toBe(2);
      expect(result.messageUnits.length).toBe(1);
      expect(result.diagnostics.budget_tokens).toBe(50);
      expect(result.diagnostics.included.length).toBeGreaterThan(0);
    });

    it('throws RangeError when required units exceed total budget', () => {
      const units = [
        { key: 'system.huge', category: 'safety', required: true, text: 'word '.repeat(100) },
      ];

      expect(() => {
        allocateContextBudget({
          units,
          budgetTokens: 10,
          tokenCounter: (text) => text.split(' ').length,
        });
      }).toThrow(RangeError);
    });

    it('omits optional units when budget is exhausted', () => {
      const units = [
        { key: 'system.prompt', category: 'safety', required: true, text: 'Must include this instruction', priority: 1000 },
        { key: 'history.low', category: 'history', required: false, text: 'Low priority extra information that will not fit into five tokens', priority: 100 },
      ];

      const result = planContextBudget({
        units,
        budgetTokens: 6,
        tokenCounter: (text) => text.split(' ').length,
      });

      expect(result.systemUnits.length).toBe(1);
      expect(result.diagnostics.omitted.length).toBe(1);
      expect(result.diagnostics.omitted[0].reason).toBe('budget_exhausted');
    });

    it('resolves budget from environment with min/max boundaries', () => {
      const budget = resolveContextBudget({ CONTEXT_BUDGET_TOKENS: '8000' });
      expect(budget).toBe(8000);

      const fallback = resolveContextBudget({});
      expect(fallback).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);

      const tooSmall = resolveContextBudget({ CONTEXT_BUDGET_TOKENS: '100' });
      expect(tooSmall).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);

      const tooLarge = resolveContextBudget({ CONTEXT_BUDGET_TOKENS: '50000' });
      expect(tooLarge).toBe(DEFAULT_CONTEXT_MAX_BUDGET_TOKENS);
    });
  });
});
