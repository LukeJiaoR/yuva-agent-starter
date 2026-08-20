-- ============================================================================
-- Vertical AI Agent SaaS Starter: Production PostgreSQL Schema
-- Exact contract parity with @yuva/billing-core and @yuva/auth-core
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Users (@yuva/auth-core contract)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    display_name VARCHAR(255),
    external_auth_provider VARCHAR(80),
    external_auth_id VARCHAR(255),
    memory_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- 5. Credit Grants (@yuva/billing-core)
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
    subscription_id VARCHAR(120),
    source_id VARCHAR(120),
    idempotency_key VARCHAR(120) UNIQUE,
    metadata JSONB DEFAULT '{}'::jsonb,
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_grants_user_spend ON credit_grants(user_id, status, credit_type, expires_at);

-- 6. Credit Usage Requests (@yuva/billing-core Idempotent Streaming & Two-Phase State Machine)
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

-- 7. Credit Usage Allocations (@yuva/billing-core)
CREATE TABLE IF NOT EXISTS credit_usage_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usage_request_id UUID NOT NULL REFERENCES credit_usage_requests(id) ON DELETE CASCADE,
    grant_id UUID NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
    reserved_credits INT NOT NULL DEFAULT 0,
    settled_credits INT NOT NULL DEFAULT 0,
    released_credits INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allocations_usage_grant ON credit_usage_allocations(usage_request_id, grant_id);

-- 8. Credit Transactions (Immutable Financial Ledger)
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
