import { describe, expect, it, vi } from 'vitest';
vi.mock('@yuva/billing-core', async (importOriginal) => ({ ...await importOriginal(),
  createOperationBillingPort: (options) => options,
}));
import { createAiProduct } from '../server/domain/aiProduct.js';
import { chatConversationId, withChatProjection, persistChatProjection, persistRecoveredChatResult } from '../server/domain/chatResultPersistence.js';

const operation = { id: 'operation-fixture', accountId: 'account-fixture', clientRequestId: 'request-fixture' };
const conversationId = '00000000-0000-5000-8000-000000000001';
const context = () => ({ operation, request: { conversationId, question: 'Question', domainKey: 'fixture' },
  output: 'Approved visible answer', providerResult: { usage: { source: 'provider', totalTokens: 0 } } });
const fulfillment = () => ({ status: 'ready', ruleVersion: '1', resultId: operation.id, accountId: operation.accountId,
  artifacts: [{ id: operation.id, accountId: operation.accountId, type: 'text', state: 'available', text: 'Approved visible answer' }] });
function client() {
  return { query: vi.fn(async (sql) => ({ rows: sql.includes('SELECT conversation_id') ? []
    : sql.includes('next_turn_sequence-1') ? [{ turn_sequence: '1' }]
      : sql.includes('INSERT INTO messages') ? [{ id: 'user' }, { id: 'assistant' }] : [{ id: 'fixture' }] })) };
}
const facts = (tx, value = withChatProjection(fulfillment(), context())) => ({ client: tx, operation,
  ledgerRequest: { id: 'ledger-fixture' }, fulfillment: value });

describe('product-owned durable chat projection', () => {
  it('uses stable account-scoped UUIDv5 IDs and preserves explicit conversation IDs', () => {
    const identity = { accountId: 'account-a', clientRequestId: 'request-a' };
    const first = chatConversationId(identity);
    expect(first).toMatch(/^[0-9a-f-]{14}5[0-9a-f-]{21}$/u);
    expect(chatConversationId(identity)).toBe(first);
    expect(chatConversationId({ ...identity, accountId: 'account-b' })).not.toBe(first);
    expect(chatConversationId({ ...identity, clientRequestId: 'request-b' })).not.toBe(first);
    expect(chatConversationId({ ...identity, conversationId })).toBe(conversationId);
  });

  it('copies recovery input before mutation without replacing custom fulfillment fields', () => {
    const input = context();
    const original = { ...fulfillment(), customFact: { approved: true } };
    const result = withChatProjection(original, input);
    input.request.question = 'Changed'; input.output = 'Changed';
    expect(result).toMatchObject({ ...original, starterChatProjection: { version: 1, writer: 'starter_chat_v1',
      accountId: operation.accountId, clientRequestId: operation.clientRequestId, conversationId,
      question: 'Question', text: 'Approved visible answer', billableTokens: 0 } });
    expect(original).not.toHaveProperty('starterChatProjection');
    expect(() => withChatProjection(result, context())).toThrow('chat_projection_conflict');
    expect(withChatProjection(original, { request: {} })).toBe(original);
  });

  it('writes conversation and exactly two messages through the supplied transaction client', async () => {
    const tx = client();
    await persistChatProjection(facts(tx));
    expect(tx.query).toHaveBeenCalledTimes(4);
    expect(tx.query.mock.calls[0][1]).toEqual([conversationId, operation.accountId, 'fixture']);
    expect(tx.query.mock.calls[1][1]).toEqual([operation.id]);
    expect(tx.query.mock.calls[2][1]).toEqual([conversationId, operation.accountId]);
    expect(tx.query.mock.calls[3][1]).toEqual([conversationId, 'Question', 'Approved visible answer', operation.accountId, '1', operation.id]);
    expect(tx.query.mock.calls[0][0]).toContain('WHERE conversations.user_id=$2 RETURNING id');
  });

  it.each(['conversation', 'messages'])('rejects zero-row %s writes instead of reporting success', async (table) => {
    const tx = client();
    tx.query.mockImplementation(async (sql) => ({ rows: sql.includes(table === 'conversation' ? 'INSERT INTO conversations' : 'INSERT INTO messages')
      ? [] : sql.includes('SELECT conversation_id') ? [] : [{ id: 'fixture', turn_sequence: '1' }] }));
    await expect(persistChatProjection(facts(tx))).rejects.toMatchObject({
      code: table === 'conversation' ? 'chat_conversation_forbidden' : 'chat_message_persistence_failed',
    });
  });

  it('replays an already projected turn without allocating another sequence', async () => {
    const tx = client(); const query = tx.query.getMockImplementation();
    tx.query.mockImplementation(async (sql, values) => sql.includes('SELECT conversation_id')
      ? { rows: [{ conversation_id: conversationId, role: 'user', content: 'Question', turn_sequence: '7' },
        { conversation_id: conversationId, role: 'assistant', content: 'Approved visible answer', turn_sequence: '7' }] }
      : query(sql, values));
    await persistChatProjection(facts(tx));
    expect(tx.query).toHaveBeenCalledTimes(2);
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO messages'))).toBe(false);
  });

  it('discards raw SQL/connection details from database failures', async () => {
    const tx = client(); tx.query.mockRejectedValue(new Error('SQL password=fixture-only host=private.invalid'));
    await expect(persistChatProjection(facts(tx))).rejects.toMatchObject({ code: 'chat_result_persistence_failed', status: 503 });
    try { await persistChatProjection(facts(tx)); } catch (error) {
      expect(error.message).not.toMatch(/SQL|password|private\.invalid/); expect(error.cause).toBeUndefined();
    }
  });

  it('uses the default writer once in both normal execution and CLI recovery', async () => {
    const product = createAiProduct({ env: { AI_PROVIDER: 'mock' } });
    const billing = product.createBilling({ db: {}, operationStore: {}, usageStore: {} });
    const value = await billing.evaluateFulfillment(context());
    const normal = client(); await billing.persistResult(facts(normal, value));
    const recovered = client(); await persistRecoveredChatResult(facts(recovered, value));
    expect(normal.query.mock.calls).toEqual(recovered.query.mock.calls);
    expect(normal.query).toHaveBeenCalledTimes(5);
    expect(normal.query.mock.calls[4][1]).toEqual(['ledger-fixture', 'Approved visible answer', 0, operation.accountId]);
  });

  it('calls custom hooks once with the original contract and never also executes the default ledger writer', async () => {
    const evaluateFulfillment = vi.fn(async () => ({ ...fulfillment(), customFact: 'kept' }));
    const persistResult = vi.fn(async () => ({ id: 'custom-result' }));
    const product = createAiProduct({ env: { AI_PROVIDER: 'mock' }, evaluateFulfillment, persistResult });
    const billing = product.createBilling({ db: {}, operationStore: {}, usageStore: {} });
    const input = context(); const value = await billing.evaluateFulfillment(input);
    expect(evaluateFulfillment).toHaveBeenCalledExactlyOnceWith(input);
    expect(value).toMatchObject({ customFact: 'kept', starterChatProjection: { writer: 'custom_chat_v1' } });
    const tx = client(); const inputFacts = facts(tx, value);
    expect(await billing.persistResult(inputFacts)).toEqual({ id: 'custom-result' });
    expect(persistResult).toHaveBeenCalledExactlyOnceWith(inputFacts);
    expect(tx.query).toHaveBeenCalledTimes(4);
    const recovery = client(); await expect(persistRecoveredChatResult(facts(recovery, value))).rejects.toThrow('chat_writer_unavailable');
    expect(recovery.query).not.toHaveBeenCalled();
  });

  it('does not fall back to the default writer when a custom hook fails', async () => {
    const persistResult = vi.fn().mockRejectedValue(new Error('custom-fixture-failure'));
    const billing = createAiProduct({ env: { AI_PROVIDER: 'mock' }, persistResult })
      .createBilling({ db: {}, operationStore: {}, usageStore: {} });
    const value = await billing.evaluateFulfillment(context()); const tx = client();
    await expect(billing.persistResult(facts(tx, value))).rejects.toThrow('custom-fixture-failure');
    expect(persistResult).toHaveBeenCalledTimes(1);
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('UPDATE credit_usage_requests'))).toBe(false);
  });

  it.each([undefined, { version: 999 }])('refuses to invent missing/unknown legacy projection during recovery', async (projection) => {
    const tx = client();
    await expect(persistRecoveredChatResult(facts(tx, { ...fulfillment(), starterChatProjection: projection })))
      .rejects.toThrow('chat_projection_unavailable');
    expect(tx.query).not.toHaveBeenCalled();
  });
});
