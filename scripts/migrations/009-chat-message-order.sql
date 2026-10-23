-- Preserve every historical message. Timestamp ties cannot by themselves tell us
-- which request a message belongs to; only unambiguous projection matches may
-- recover a paired turn. Never rewrite operations or the financial ledger.
ALTER TABLE conversations ADD COLUMN next_turn_sequence BIGINT NOT NULL DEFAULT 1
  CHECK (next_turn_sequence > 0);
ALTER TABLE messages ADD COLUMN turn_sequence BIGINT;
ALTER TABLE messages ADD COLUMN role_order SMALLINT;
ALTER TABLE messages ADD COLUMN source_operation_id UUID;
ALTER TABLE messages ADD COLUMN ordering_source VARCHAR(24) NOT NULL DEFAULT 'legacy_unknown'
  CHECK (ordering_source IN ('legacy_unknown','legacy_timestamp','legacy_projection','projected'));

WITH timestamp_groups AS (
  SELECT conversation_id, created_at, COUNT(*) AS message_count,
    COUNT(*) FILTER (WHERE role='user') AS users,
    COUNT(*) FILTER (WHERE role='assistant') AS assistants,
    MAX(content) FILTER (WHERE role='user') AS question,
    MAX(content) FILTER (WHERE role='assistant') AS answer
  FROM messages WHERE created_at IS NOT NULL GROUP BY conversation_id, created_at
), projection_matches AS (
  SELECT g.conversation_id, g.created_at, o.id AS operation_id,
    COUNT(*) OVER (PARTITION BY g.conversation_id,g.created_at) AS group_matches,
    COUNT(*) OVER (PARTITION BY o.id) AS operation_matches
  FROM timestamp_groups g
  JOIN conversations c ON c.id=g.conversation_id
  JOIN ai_operations o ON o.account_id=c.user_id AND o.task_type='text'
    AND o.financial_status IN ('settled','no_charge') AND o.fulfillment_status='ready'
    AND o.fulfillment->'starterChatProjection'->>'version'='1'
    AND o.fulfillment->'starterChatProjection'->>'accountId'=c.user_id::text
    AND o.fulfillment->'starterChatProjection'->>'clientRequestId'=o.client_request_id
    AND o.fulfillment->'starterChatProjection'->>'conversationId'=c.id::text
    AND o.fulfillment->'starterChatProjection'->>'question'=g.question
    AND o.fulfillment->'starterChatProjection'->>'text'=g.answer
  WHERE g.message_count=2 AND g.users=1 AND g.assistants=1
), ordered_groups AS (
  SELECT g.conversation_id,g.created_at,p.operation_id,
    CASE WHEN g.message_count=1 THEN 'legacy_timestamp' ELSE 'legacy_projection' END AS source,
    ROW_NUMBER() OVER (PARTITION BY g.conversation_id ORDER BY g.created_at) AS sequence
  FROM timestamp_groups g LEFT JOIN projection_matches p ON p.conversation_id=g.conversation_id
    AND p.created_at=g.created_at AND p.group_matches=1 AND p.operation_matches=1
  WHERE g.message_count=1 OR p.operation_id IS NOT NULL
)
UPDATE messages m SET turn_sequence=g.sequence,
  role_order=CASE WHEN m.role='assistant' THEN 1 ELSE 0 END,
  source_operation_id=g.operation_id, ordering_source=g.source
FROM ordered_groups g WHERE m.conversation_id=g.conversation_id AND m.created_at=g.created_at;

UPDATE conversations c SET next_turn_sequence=COALESCE((SELECT MAX(m.turn_sequence)+1
  FROM messages m WHERE m.conversation_id=c.id),1);

ALTER TABLE messages ADD CONSTRAINT messages_order_contract CHECK (
  (ordering_source='legacy_unknown' AND turn_sequence IS NULL AND role_order IS NULL AND source_operation_id IS NULL)
  OR (ordering_source<>'legacy_unknown' AND turn_sequence IS NOT NULL AND turn_sequence>0
    AND role_order IS NOT NULL AND role_order IN (0,1)
    AND ((ordering_source='legacy_timestamp' AND source_operation_id IS NULL)
      OR (ordering_source IN ('legacy_projection','projected') AND source_operation_id IS NOT NULL
        AND ((role='user' AND role_order=0) OR (role='assistant' AND role_order=1))))));
CREATE UNIQUE INDEX idx_messages_turn_role ON messages(conversation_id,turn_sequence,role_order)
  WHERE turn_sequence IS NOT NULL;
CREATE UNIQUE INDEX idx_messages_operation_role ON messages(source_operation_id,role_order)
  WHERE source_operation_id IS NOT NULL;
CREATE INDEX idx_messages_unordered ON messages(conversation_id) WHERE turn_sequence IS NULL;
COMMENT ON COLUMN messages.turn_sequence IS 'Conversation-local transaction order. Legacy timestamp-only singletons retain provable chronological order; unresolved ties remain NULL.';
