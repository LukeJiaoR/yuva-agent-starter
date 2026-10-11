// Product-owned contracts: bump together when prompt, material schema or output rules change.
export const INPUT_VERSION = 'knowledge-answer-v1';
export const DOMAIN_KEY = 'knowledge-assistant';
export const LIMITS = Object.freeze({ maxCalls: 1, maxRetries: 0,
  maxInputTokens: 2000, maxOutputTokens: 128, deadlineMs: 1000 });
export const PRICING = Object.freeze({ strategy: 'fixed', featureKey: 'knowledge_answer', credits: 0, limits: LIMITS });

export function materialFacts(input) {
  const material = input.parameters?.material;
  if (typeof material !== 'string' || !material.trim() || material.length > 800) {
    throw Object.assign(new Error('Supply between 1 and 800 characters of material'), { status: 400, code: 'invalid_request' });
  }
  return { material: material.trim(), schemaVersion: INPUT_VERSION };
}
export function validateAnswer({ text }) {
  return { valid: text.length <= 600 && text.startsWith('Answer: '), visibleText: text };
}
