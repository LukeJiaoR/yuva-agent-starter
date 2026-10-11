import { describe, it, expect } from 'vitest';
import * as knowledge from '../../examples/knowledge-assistant/starter-app/server/domain/contract.js';
import * as content from '../../examples/token-content-tool/starter-app/server/domain/contract.js';
import { DomainPrompts as knowledgePrompts } from '../../examples/knowledge-assistant/starter-app/server/domain/prompts.js';
import { DomainPrompts as contentPrompts } from '../../examples/token-content-tool/starter-app/server/domain/prompts.js';

describe('product-owned example contracts', () => {
  it.each([knowledge, content])('requires bounded given material and rejects missing/oversized schemas', contract => {
    expect(contract.materialFacts({ parameters: { material: '  Synthetic material.  ' } }))
      .toEqual({ material: 'Synthetic material.', schemaVersion: contract.INPUT_VERSION });
    for (const material of [undefined, '', ' ', {}, 'x'.repeat(801)])
      expect(() => contract.materialFacts({ parameters: { material } })).toThrow();
  });
  it('makes zero charge explicit while retaining a bounded execution plan', () => {
    expect(knowledge.PRICING).toMatchObject({ strategy: 'fixed', credits: 0,
      limits: { maxCalls: 1, maxRetries: 0, maxInputTokens: 2000, maxOutputTokens: 128, deadlineMs: 1000 } });
    expect(knowledgePrompts.version).toBe(knowledge.INPUT_VERSION);
    expect(knowledgePrompts.formatSystemPrompt()).toContain('no retrieval or RAG');
    expect(knowledge.validateAnswer({ text: 'Answer: Synthetic answer.' }).valid).toBe(true);
    expect(knowledge.validateAnswer({ text: 'Unstructured' }).valid).toBe(false);
  });
  it('owns token prices and rejects JSON outside the exact content schema', () => {
    expect(content.PRICING).toMatchObject({ strategy: 'token', allowEstimates: false });
    expect(contentPrompts.version).toBe(content.INPUT_VERSION);
    expect(content.validateCard({ text: '{"title":"Demo","summary":"Synthetic."}' }).valid).toBe(true);
    for (const value of [null, [], {}, { title: '', summary: 'a' }, { title: 'a', summary: 'b', extra: true },
      { title: 'a', summary: 'x'.repeat(401) }])
      expect(content.validateCard({ text: JSON.stringify(value) }).valid).toBe(false);
    expect(content.validateCard({ text: 'not json' }).valid).toBe(false);
  });
});
