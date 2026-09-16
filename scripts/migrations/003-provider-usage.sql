CREATE TABLE ai_provider_calls (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES ai_operations(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  provider VARCHAR(80) NOT NULL,
  model VARCHAR(160) NOT NULL,
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  outcome VARCHAR(30) NOT NULL DEFAULT 'started',
  provider_request_id VARCHAR(255),
  provider_job_id VARCHAR(255),
  metrics JSONB NOT NULL DEFAULT '{}',
  cost JSONB,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observed_at TIMESTAMPTZ,
  UNIQUE(operation_id, id)
);
CREATE INDEX ai_provider_calls_operation ON ai_provider_calls(operation_id,started_at,id);
CREATE TABLE ai_usage_observations (
  call_id UUID NOT NULL REFERENCES ai_provider_calls(id),
  digest CHAR(64) NOT NULL,
  observation JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(call_id,digest)
);
