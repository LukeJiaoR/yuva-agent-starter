/** Assemble all supplied context without application-budget or priority pruning.
 * tokenCounter is diagnostic only; product credit units are not model tokens.
 * The provider owns its actual context-window limit.
 */
export function assembleConversationContext({ units = [], tokenCounter = () => 0 } = {}) {
  const selected = units.filter(Boolean).map((unit, order) => {
    if (typeof unit.text !== 'string') throw new TypeError('Context text must be a string');
    const count = tokenCounter(unit.text);
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid diagnostic text count');
    return { ...unit, order, channel: unit.channel === 'message' ? 'message' : 'system', requestedTokens: count };
  });
  const included = selected.map(unit => ({ key: unit.key, category: unit.category,
    channel: unit.channel, reason: 'included', requested_tokens: unit.requestedTokens,
    included_tokens: unit.requestedTokens, omitted_tokens: 0 }));
  const total = included.reduce((sum, unit) => sum + unit.included_tokens, 0);
  const systemUnits = selected.filter(unit => unit.channel === 'system');
  const messageUnits = selected.filter(unit => unit.channel === 'message');
  return { systemUnits, messageUnits,
    systemPrompt: systemUnits.map(unit => unit.text).join('\n'),
    messages: messageUnits.flatMap(unit => unit.payload || { role: 'user', content: unit.text }),
    diagnostics: { policy: 'complete', budget_tokens: null, requested_tokens: total,
      included_tokens: total, omitted_tokens: 0, used_tokens: total, remaining_tokens: null,
      included, omitted: [], capacity_authority: 'provider' },
    usedTokens: total, budgetTokens: null };
}

/** Storage adapters return oldest-first pages from one authorized conversation. */
export async function loadConversationMessages({ readPage, pageSize = 100 } = {}) {
  if (typeof readPage !== 'function') throw new TypeError('Conversation page reader is required');
  const messages = [], seen = new Set();
  let cursor = null;
  do {
    const page = await readPage({ cursor, limit: pageSize });
    if (!page || !Array.isArray(page.messages)) throw new TypeError('Invalid conversation page');
    messages.push(...page.messages);
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      const key = JSON.stringify(cursor);
      if (seen.has(key) || !page.messages.length) throw new Error('Conversation cursor did not advance');
      seen.add(key);
    }
  } while (cursor !== null);
  return messages;
}
