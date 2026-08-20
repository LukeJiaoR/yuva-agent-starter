-- ============================================================================
-- Vertical AI Agent SaaS Starter: PostgreSQL Schema
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
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

-- 4. Credit Balances
CREATE TABLE IF NOT EXISTS credit_balances (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    available INT NOT NULL DEFAULT 0 CHECK (available >= 0),
    reserved INT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    debt INT NOT NULL DEFAULT 0 CHECK (debt >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Credit Usage Requests (Idempotent Request Tracking & Replay)
CREATE TABLE IF NOT EXISTS credit_usage_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    client_request_id VARCHAR(120) NOT NULL,
    pipeline_run_id VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'settled', 'released', 'refunded', 'reconciliation_required')),
    reserved_credits INT NOT NULL DEFAULT 0,
    settled_credits INT NOT NULL DEFAULT 0,
    billable_tokens INT NOT NULL DEFAULT 0,
    assistant_text TEXT,
    stream_public_metadata JSONB DEFAULT '{}'::jsonb,
    failure_class VARCHAR(60),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    settled_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_user_client_request UNIQUE (user_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_requests_user_client ON credit_usage_requests(user_id, client_request_id);
CREATE INDEX IF NOT EXISTS idx_credit_requests_status ON credit_usage_requests(status);
