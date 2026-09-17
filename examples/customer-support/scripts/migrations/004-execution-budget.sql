ALTER TABLE ai_provider_calls
  ADD COLUMN call_kind VARCHAR(20) NOT NULL DEFAULT 'primary' CHECK (call_kind IN ('primary','retry')),
  ADD COLUMN retry_of UUID REFERENCES ai_provider_calls(id),
  ADD COLUMN budget_resources JSONB,
  ADD COLUMN external_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (external_status IN ('unknown','completed'));
UPDATE ai_provider_calls SET external_status='completed' WHERE outcome='succeeded' OR failure_code='provider_refusal';
