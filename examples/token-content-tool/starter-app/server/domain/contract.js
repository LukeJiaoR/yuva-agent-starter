export const INPUT_VERSION = 'content-card-v1';
export const DOMAIN_KEY = 'token-content-tool';
export const LIMITS = Object.freeze({ maxCalls: 1, maxRetries: 0,
  maxInputTokens: 2000, maxOutputTokens: 128, deadlineMs: 5000 });
export const PRICING = Object.freeze({ strategy: 'token', featureKey: 'content_card',
  inputRate: { credits: 1, tokens: 1000 }, outputRate: { credits: 2, tokens: 1000 },
  allowEstimates: false, limits: LIMITS });

export function materialFacts(input) {
  const material = input.parameters?.material;
  if (typeof material !== 'string' || !material.trim() || material.length > 800) {
    throw Object.assign(new Error('Supply between 1 and 800 characters of material'), { status: 400, code: 'invalid_request' });
  }
  return { material: material.trim(), schemaVersion: INPUT_VERSION };
}
export function validateCard({ text }) {
  try {
    const card = JSON.parse(text);
    const valid = card !== null && typeof card === 'object' && !Array.isArray(card)
      && Object.keys(card).sort().join(',') === 'summary,title'
      && typeof card.title === 'string' && card.title.length > 0 && card.title.length <= 80
      && typeof card.summary === 'string' && card.summary.length > 0 && card.summary.length <= 400;
    return { valid, visibleText: valid ? JSON.stringify(card) : '' };
  } catch { return { valid: false }; }
}
