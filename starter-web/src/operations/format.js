export const metricLabels = { inputTokens: 'Input tokens', outputTokens: 'Output tokens', totalTokens: 'Total tokens', cachedInputTokens: 'Cached input tokens', cacheWriteTokens: 'Cache write tokens', reasoningTokens: 'Reasoning tokens', toolTokens: 'Tool tokens', images: 'Images', durationMs: 'Duration (ms)' };
export function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : 'Unknown'; }
export function count(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : 'Unknown'; }
export function source(value) { return ({ provider: 'Provider reported', estimate: 'Estimated', synthetic: 'Synthetic', missing: 'Missing' })[value] || 'Unknown source'; }
export function date(value) { const parsed = typeof value === 'string' ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Unknown'; }
export function age(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.floor(value)} seconds (at last read)` : value === null ? 'Not pending' : 'Unknown'; }
export function costLabel(cost) {
  if (!cost || cost.status === 'missing' || cost.amount == null) return 'Unknown cost · Missing';
  if (typeof cost.amount !== 'string' || !/^\d{1,30}$/.test(cost.amount) || !Number.isInteger(cost.scale) || cost.scale < 0 || cost.scale > 12 || !/^[A-Z]{3,8}$/.test(cost.currency || '')) return 'Unknown cost';
  const digits = String(cost.amount).padStart(cost.scale + 1, '0');
  const amount = cost.scale ? `${digits.slice(0, -cost.scale)}.${digits.slice(-cost.scale)}` : digits;
  const status = ({ observed: 'Observed', estimated: 'Estimated', reconciled: 'Reconciled' })[cost.status] || 'Unknown status';
  return `${amount} ${cost.currency} · ${source(cost.source)} · ${status}`;
}
