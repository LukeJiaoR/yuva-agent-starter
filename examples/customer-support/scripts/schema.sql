-- ============================================================================
-- Vertical AI Agent SaaS Starter: Production PostgreSQL Schema
-- Exact contract parity with @yuva/billing-core and @yuva/auth-core
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS starter_schema_versions (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO starter_schema_versions (version, description)
VALUES (1, 'Initial reusable agent SaaS contract')
ON CONFLICT (version) DO NOTHING;

-- 1. Users (@yuva/auth-core contract)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    display_name VARCHAR(255),
    auth_provider VARCHAR(80),
    external_auth_provider VARCHAR(80),
    external_auth_id VARCHAR(255),
    memory_enabled BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_external_auth ON users(external_auth_provider, external_auth_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2. Conversations (Multi-turn Chat & Domain Context)
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_key VARCHAR(80) NOT NULL DEFAULT 'default',
    title VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

-- 3. Messages (Multi-turn Conversation History)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);

-- 4. Credit Accounts (@yuva/billing-core)
CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    available_credits INT NOT NULL DEFAULT 0,
    reserved_credits INT NOT NULL DEFAULT 0,
    credit_debt INT NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Credit Subscriptions (@yuva/billing-core)
CREATE TABLE IF NOT EXISTS credit_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(40) NOT NULL DEFAULT 'generic',
    provider_subscription_id VARCHAR(255) NOT NULL UNIQUE,
    product_key VARCHAR(80) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN (
      'active', 'scheduled_cancel', 'past_due', 'expired', 'canceled', 'refunded'
    )),
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    next_transaction_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    last_transaction_id VARCHAR(255),
    entitlement_transaction_id VARCHAR(255),
    next_entitlement_period INTEGER CHECK (next_entitlement_period IS NULL OR next_entitlement_period >= 0),
    next_entitlement_at TIMESTAMPTZ,
    last_event_id VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_subscriptions_user_status
    ON credit_subscriptions(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_subscriptions_entitlement_due
    ON credit_subscriptions(next_entitlement_at, id)
    WHERE status = 'active' AND entitlement_transaction_id IS NOT NULL;

-- 6. Credit Grants (@yuva/billing-core)
CREATE TABLE IF NOT EXISTS credit_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credit_type VARCHAR(40) NOT NULL DEFAULT 'purchased',
    source_type VARCHAR(80) DEFAULT 'purchase',
    original_credits INT NOT NULL DEFAULT 0,
    remaining_credits INT NOT NULL DEFAULT 0,
    reserved_credits INT NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ,
    payment_reference VARCHAR(120),
    order_reference VARCHAR(120),
    product_key VARCHAR(80),
    subscription_id UUID REFERENCES credit_subscriptions(id) ON DELETE SET NULL,
    source_id VARCHAR(120),
    idempotency_key VARCHAR(120) UNIQUE,
    metadata JSONB DEFAULT '{}'::jsonb,
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_grants_user_spend ON credit_grants(user_id, status, credit_type, expires_at);

-- 7. Credit Usage Requests (@yuva/billing-core Idempotent Streaming & Two-Phase State Machine)
CREATE TABLE IF NOT EXISTS credit_usage_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    feature_key VARCHAR(80) NOT NULL,
    chart_id UUID,
    client_request_id VARCHAR(120) NOT NULL,
    idempotency_key VARCHAR(200) NOT NULL,
    pricing_strategy VARCHAR(40) NOT NULL DEFAULT 'fixed',
    status VARCHAR(40) NOT NULL DEFAULT 'generating',
    attempt_no INT NOT NULL DEFAULT 1,
    reserved_credits INT NOT NULL DEFAULT 0,
    settled_credits INT NOT NULL DEFAULT 0,
    credits_released INT NOT NULL DEFAULT 0,
    billable_tokens INT NOT NULL DEFAULT 0,
    balance_before INT DEFAULT 0,
    balance_after INT,
    result_id VARCHAR(120),
    assistant_text TEXT,
    stream_public_metadata JSONB DEFAULT '{}'::jsonb,
    failure_class VARCHAR(60),
    metadata JSONB DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_credit_usage_user_client UNIQUE (user_id, client_request_id),
    CONSTRAINT uq_credit_usage_idempotency UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_credit_usage_user_status ON credit_usage_requests(user_id, status);

-- 8. Credit Usage Allocations (@yuva/billing-core)
CREATE TABLE IF NOT EXISTS credit_usage_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usage_request_id UUID NOT NULL REFERENCES credit_usage_requests(id) ON DELETE CASCADE,
    grant_id UUID NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
    attempt_no INT NOT NULL DEFAULT 1,
    reserved_credits INT NOT NULL DEFAULT 0,
    settled_credits INT NOT NULL DEFAULT 0,
    released_credits INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allocations_usage_grant ON credit_usage_allocations(usage_request_id, grant_id);
CREATE INDEX IF NOT EXISTS idx_allocations_usage_attempt ON credit_usage_allocations(usage_request_id, attempt_no, grant_id);

-- 9. Credit Transactions (Immutable Financial Ledger)
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grant_id UUID REFERENCES credit_grants(id) ON DELETE SET NULL,
    usage_request_id UUID REFERENCES credit_usage_requests(id) ON DELETE SET NULL,
    credit_type VARCHAR(40),
    direction VARCHAR(20) DEFAULT 'debit',
    amount INT NOT NULL DEFAULT 0,
    transaction_type VARCHAR(60) NOT NULL DEFAULT 'usage_reserve',
    status VARCHAR(40) NOT NULL DEFAULT 'posted',
    source_type VARCHAR(80),
    source_id VARCHAR(120),
    available_delta INT NOT NULL DEFAULT 0,
    reserved_delta INT NOT NULL DEFAULT 0,
    debt_delta INT NOT NULL DEFAULT 0,
    available_after INT NOT NULL DEFAULT 0,
    reserved_after INT NOT NULL DEFAULT 0,
    debt_after INT NOT NULL DEFAULT 0,
    idempotency_key VARCHAR(200) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ,
    reason VARCHAR(255),
    reference_id VARCHAR(120),
    metadata JSONB DEFAULT '{}'::jsonb,
    reversal_of_transaction_id UUID REFERENCES credit_transactions(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id, created_at DESC);

-- 10. Payment identity lock target used by billing-core integrations
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(40) NOT NULL CHECK (type IN ('credits', 'subscription', 'other')),
    provider VARCHAR(40) NOT NULL DEFAULT 'generic',
    provider_reference VARCHAR(255) UNIQUE,
    status VARCHAR(40) NOT NULL DEFAULT 'pending',
    amount_minor INTEGER,
    currency VARCHAR(3) DEFAULT 'USD',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);

-- 11. Admin action audit contract (@yuva/admin-core)
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id VARCHAR(255),
    actor_email VARCHAR(320) NOT NULL,
    actor_role VARCHAR(32) CHECK (
      actor_role IS NULL OR actor_role IN ('support', 'product', 'finance', 'super_admin')
    ),
    action VARCHAR(80) NOT NULL,
    target_type VARCHAR(80) NOT NULL,
    target_id VARCHAR(255) NOT NULL,
    environment VARCHAR(16) NOT NULL CHECK (environment IN ('test', 'production')),
    request_id UUID NOT NULL UNIQUE,
    idempotency_key VARCHAR(255),
    request_hash CHAR(64),
    reason VARCHAR(500) NOT NULL,
    before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL CHECK (
      status IN ('pending', 'succeeded', 'failed', 'needs_reconciliation')
    ),
    error_code VARCHAR(80),
    result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target
    ON admin_audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor
    ON admin_audit_logs(actor_email, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_logs_actor_action_idempotency
    ON admin_audit_logs(actor_email, action, idempotency_key);

-- 12. Database-backed rate limiting contract (@yuva/auth-core)
CREATE TABLE IF NOT EXISTS rate_limits (
    key VARCHAR(255) PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION check_rate_limit(
    p_key VARCHAR,
    p_max INTEGER DEFAULT 20,
    p_window_seconds INTEGER DEFAULT 60
) RETURNS BOOLEAN AS $$
DECLARE
    v_allowed BOOLEAN;
BEGIN
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (p_key, 1, NOW())
    ON CONFLICT (key) DO UPDATE
    SET count = CASE
          WHEN NOW() - rate_limits.window_start > (p_window_seconds || ' seconds')::INTERVAL THEN 1
          ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN NOW() - rate_limits.window_start > (p_window_seconds || ' seconds')::INTERVAL THEN NOW()
          ELSE rate_limits.window_start
        END
    RETURNING count <= p_max INTO v_allowed;
    RETURN v_allowed;
END;
$$ LANGUAGE plpgsql;
