-- Additive operation identities for standalone administrative deductions.
-- Existing financial history is deliberately neither rewritten nor inferred.
CREATE TABLE credit_mutations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(80) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, action, idempotency_key)
);
