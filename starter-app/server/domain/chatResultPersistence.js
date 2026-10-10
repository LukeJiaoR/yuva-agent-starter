import { createHash } from 'node:crypto';
import { invariant } from '@yuva/billing-core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_WRITER = 'starter_chat_v1';
const CUSTOM_WRITER = 'custom_chat_v1';
const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

async function write(client, sql, values) {
  try { return await client.query(sql, values); }
  catch {
    throw Object.assign(new Error('Chat result persistence is temporarily unavailable.'), {
      code: 'chat_result_persistence_failed', status: 503, retryable: true,
    });
  }
}

/** UUIDv5: stable before reservation without changing the legacy input fingerprint. */
export function chatConversationId({ accountId, clientRequestId, conversationId }) {
  if (conversationId) return conversationId;
  invariant(typeof accountId === 'string' && typeof clientRequestId === 'string', 'chat_identity_unavailable');
  const bytes = createHash('sha1').update(namespace)
    .update(JSON.stringify(['starter-chat-v1', accountId, clientRequestId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateProjection(projection, operation) {
  invariant(projection?.version === 1, 'chat_projection_unavailable');
  invariant(projection.accountId === operation.accountId && projection.clientRequestId === operation.clientRequestId,
    'chat_projection_forbidden', 403);
  invariant(UUID.test(projection.conversationId), 'chat_projection_invalid');
  invariant(typeof projection.question === 'string' && projection.question.length > 0 && projection.question.length <= 4000,
    'chat_projection_invalid');
  invariant(typeof projection.text === 'string' && projection.text.length > 0 && projection.text.length <= 2 * 1024 * 1024,
    'chat_projection_invalid');
  invariant(typeof projection.domainKey === 'string' && projection.domainKey.length > 0 && projection.domainKey.length <= 80,
    'chat_projection_invalid');
  invariant(projection.billableTokens === null || Number.isSafeInteger(projection.billableTokens) && projection.billableTokens >= 0,
    'chat_projection_invalid');
  invariant([DEFAULT_WRITER, CUSTOM_WRITER].includes(projection.writer), 'chat_writer_unavailable');
  return projection;
}

/** Product-owned durable projection; do not replace custom fulfillment fields. */
export function withChatProjection(fulfillment, { request, operation, output, providerResult }, { customWriter = false } = {}) {
  if (!request?.conversationId) return fulfillment;
  invariant(!Object.hasOwn(fulfillment, 'starterChatProjection'), 'chat_projection_conflict');
  const projection = validateProjection({ version: 1, writer: customWriter ? CUSTOM_WRITER : DEFAULT_WRITER,
    accountId: operation.accountId, clientRequestId: operation.clientRequestId,
    conversationId: request.conversationId, question: request.question, domainKey: request.domainKey,
    text: output, billableTokens: providerResult?.usage?.source === 'provider' ? providerResult.usage.totalTokens ?? null : null,
  }, operation);
  return { ...fulfillment, starterChatProjection: projection };
}

/** Must receive the settlement transaction client, never the pool. */
export async function persistChatProjection({ client, operation, fulfillment }) {
  const projection = validateProjection(fulfillment?.starterChatProjection, operation);
  const conversation = await write(client, `INSERT INTO conversations (id,user_id,domain_key,updated_at)
    VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO UPDATE SET updated_at=NOW()
    WHERE conversations.user_id=$2 RETURNING id`, [projection.conversationId, operation.accountId, projection.domainKey]);
  invariant(conversation.rows.length === 1, 'chat_conversation_forbidden', 403);
  const messages = await write(client, `INSERT INTO messages (conversation_id,role,content,created_at)
    SELECT c.id,'user',$2,NOW() FROM conversations c WHERE c.id=$1 AND c.user_id=$4
    UNION ALL SELECT c.id,'assistant',$3,NOW() FROM conversations c WHERE c.id=$1 AND c.user_id=$4
    RETURNING id`, [projection.conversationId, projection.question, projection.text, operation.accountId]);
  invariant(messages.rows.length === 2, 'chat_message_persistence_failed');
}

export async function persistDefaultTextResult({ client, ledgerRequest, operation, fulfillment, output, providerResult }) {
  const projection = fulfillment?.starterChatProjection;
  const text = projection ? validateProjection(projection, operation).text : output;
  const billableTokens = projection ? projection.billableTokens
    : providerResult?.usage?.source === 'provider' ? providerResult.usage.totalTokens ?? null : null;
  await write(client, `UPDATE credit_usage_requests SET assistant_text=$2,billable_tokens=$3,settled_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND user_id=$4`, [ledgerRequest.id, text, billableTokens, operation.accountId]);
  return { id: ledgerRequest.id };
}

/** CLI cannot reconstruct arbitrary injected hooks or historical missing input. */
export async function persistRecoveredChatResult(facts) {
  const projection = validateProjection(facts.fulfillment?.starterChatProjection, facts.operation);
  invariant(projection.writer === DEFAULT_WRITER, 'chat_writer_unavailable');
  await persistChatProjection(facts);
  return persistDefaultTextResult(facts);
}

/** Inspection only: no writer is called, and no recovery input is invented. */
export function chatRecoveryProjectionIssue(fulfillment, operation) {
  try {
    const projection = validateProjection(fulfillment?.starterChatProjection, operation);
    return projection.writer === DEFAULT_WRITER ? null : 'chat_writer_unavailable';
  } catch (error) {
    return ['chat_projection_unavailable', 'chat_projection_forbidden', 'chat_projection_invalid', 'chat_writer_unavailable']
      .includes(error.code) ? error.code : 'chat_projection_unavailable';
  }
}
