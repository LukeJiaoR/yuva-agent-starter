CREATE TABLE ai_operations (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES users(id),
  client_request_id VARCHAR(120) NOT NULL,
  feature_key VARCHAR(80) NOT NULL,
  task_type VARCHAR(20) NOT NULL CHECK (task_type IN ('text','image','video')),
  execution_mode VARCHAR(20) NOT NULL CHECK (execution_mode IN ('sync','stream','async')),
  input_version VARCHAR(80) NOT NULL,
  input_fingerprint CHAR(64) NOT NULL,
  quote JSONB NOT NULL,
  ledger_request_id UUID UNIQUE REFERENCES credit_usage_requests(id),
  execution_status VARCHAR(40) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, client_request_id)
);
CREATE FUNCTION protect_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.account_id,NEW.client_request_id,NEW.feature_key,NEW.task_type,
         NEW.execution_mode,NEW.input_version,NEW.input_fingerprint,NEW.quote,NEW.ledger_request_id)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.account_id,OLD.client_request_id,OLD.feature_key,OLD.task_type,
         OLD.execution_mode,OLD.input_version,OLD.input_fingerprint,OLD.quote,OLD.ledger_request_id)
  THEN RAISE EXCEPTION 'operation identity and quote are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_operation_immutable BEFORE UPDATE ON ai_operations
FOR EACH ROW EXECUTE FUNCTION protect_operation_identity();
