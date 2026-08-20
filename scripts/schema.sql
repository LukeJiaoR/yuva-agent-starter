-- ============================================================================
-- Vertical AI Agent SaaS Starter: Production PostgreSQL Schema
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    external_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_key VARCHAR(80) NOT NULL DEFAULT 'default',
    title VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

-- 3. Messages
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- 4. Credit Accounts
CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    available_credits INT NOT NULL DEFAULT 0 CHECK (available_credits >= 0),
    reserved_credits INT NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
    credit_debt INT NOT NULL DEFAULT 0 CHECK (credit_debt >= 0),
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Credit Grants
CREATE TABLE IF NOT EXISTS credit_grants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credit_type VARCHAR(40) NOT NULL DEFAULT 'purchased' CHECK (credit_type IN ('membership', 'purchased')),
    initial_amount INT NOT NULL CHECK (initial_amount > 0),
    remaining_credits INT NOT NULL DEFAULT 0 CHECK (remaining_credits >= 0),
    reserved_credits INT NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
    status VARCHAR(40) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
    expires_at TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(120) UNIQUE,
    reason VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON credit_grants(user_id, status);

-- 6. Credit Usage Requests (Idempotent Request Tracking & Replay)
CREATE TABLE IF NOT EXISTS credit_usage_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    feature_key VARCHAR(80) NOT NULL,
    chart_id UUID,
    client_request_id VARCHAR(120) NOT NULL,
    idempotency_key VARCHAR(200) NOT NULL,
    pricing_strategy VARCHAR(40) NOT NULL DEFAULT 'fixed',
    status VARCHAR(40) NOT NULL DEFAULT 'generating' CHECK (status IN ('reserved', 'generating', 'settled', 'released', 'refunded', 'reconciliation_required')),
    reserved_credits INT NOT NULL DEFAULT 0,
    settled_credits INT NOT NULL DEFAULT 0,
    billable_tokens INT NOT NULL DEFAULT 0,
    balance_before INT DEFAULT 0,
    balance_after INT,
    assistant_text TEXT,
    stream_public_metadata JSONB DEFAULT '{}'::jsonb,
    failure_class VARCHAR(60),
    metadata JSONB DEFAULT '{}'::jsonb,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    settled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_credit_usage_user_client UNIQUE (user_id, client_request_id),
    CONSTRAINT uq_credit_usage_idempotency UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_credit_usage_user_status ON credit_usage_requests(user_id, status);

-- 7. Credit Usage Allocations
CREATE TABLE IF NOT EXISTS credit_usage_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usage_request_id UUID NOT NULL REFERENCES credit_usage_requests(id) ON DELETE CASCADE,
    grant_id UUID NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
    reserved_credits INT NOT NULL DEFAULT 0,
    settled_credits INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allocations_usage ON credit_usage_allocations(usage_request_id);

-- 8. Credit Transactions (Immutable Financial Ledger)
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grant_id UUID REFERENCES credit_grants(id) ON DELETE SET NULL,
    usage_request_id UUID REFERENCES credit_usage_requests(id) ON DELETE SET NULL,
    credit_type VARCHAR(40) NOT NULL,
    entry_type VARCHAR(60) NOT NULL,
    available_delta INT NOT NULL,
    reserved_delta INT NOT NULL,
    balance_after INT NOT NULL,
    idempotency_key VARCHAR(200) UNIQUE NOT NULL,
    source_type VARCHAR(80),
    source_id VARCHAR(120),
    reason VARCHAR(255),
    reversal_of_transaction_id UUID REFERENCES credit_transactions(id),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id, created_at);
