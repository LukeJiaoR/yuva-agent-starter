ALTER TABLE ai_operations
  ADD COLUMN financial_status VARCHAR(40) NOT NULL DEFAULT 'unreserved'
    CHECK (financial_status IN ('unreserved','reserved','settled','no_charge','released','reconciliation_required')),
  ADD COLUMN fulfillment_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (fulfillment_status IN ('pending','partial','ready','failed')),
  ADD COLUMN fulfillment JSONB,
  ADD COLUMN decision JSONB,
  ADD COLUMN reconciliation_reason VARCHAR(160);

UPDATE ai_operations o SET financial_status=CASE
  WHEN r.status='settled' THEN 'settled' WHEN r.status='released' THEN 'released'
  WHEN r.status='reconciliation_required' THEN 'reconciliation_required' ELSE 'reserved' END,
  execution_status=CASE WHEN r.status='settled' THEN 'succeeded' WHEN r.status='released' THEN 'failed' ELSE o.execution_status END
FROM credit_usage_requests r WHERE r.id=o.ledger_request_id;

UPDATE ai_operations o SET decision=jsonb_build_object('action','settle','credits',r.settled_credits,'reason','legacy_settled')
FROM credit_usage_requests r WHERE r.id=o.ledger_request_id AND r.status='settled';

-- Starter-owned compatibility projection; core settlement never requires these text columns.
UPDATE ai_operations o SET fulfillment_status='ready', fulfillment=jsonb_build_object(
  'status','ready','ruleVersion',o.quote->>'fulfillmentVersion','accountId',o.account_id,
  'resultId',r.id,'artifacts',jsonb_build_array(jsonb_build_object('id',r.id,'accountId',o.account_id,
    'type','text','state','available','text',r.assistant_text)))
FROM credit_usage_requests r WHERE r.id=o.ledger_request_id AND r.status='settled' AND length(r.assistant_text)>0;
