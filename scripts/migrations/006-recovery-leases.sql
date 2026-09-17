ALTER TABLE ai_operations
  ADD COLUMN execution_epoch INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN lease_owner VARCHAR(120),
  ADD COLUMN lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_recovery_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN recovery_error VARCHAR(160),
  ADD COLUMN manual_review BOOLEAN NOT NULL DEFAULT false;

UPDATE ai_operations SET lease_expires_at=created_at + ((quote->'limits'->>'deadlineMs')::bigint + 60000) * interval '1 millisecond';

CREATE TABLE ai_recovery_events (
  id BIGSERIAL PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES ai_operations(id),
  execution_epoch INTEGER NOT NULL,
  action VARCHAR(80) NOT NULL,
  reason VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ai_recovery_due ON ai_operations(next_recovery_at,lease_expires_at)
  WHERE financial_status NOT IN ('settled','no_charge','released');
