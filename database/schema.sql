-- FreeFollowersTik Database Schema
-- TikTok-only authentication

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- USERS
-- ==========================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tiktok_open_id VARCHAR(255) NOT NULL UNIQUE,
    tiktok_union_id VARCHAR(255),

    display_name VARCHAR(100),
    avatar_url TEXT,

    access_token TEXT,
    refresh_token TEXT,

    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,

    coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- COIN TRANSACTIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS coin_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    type VARCHAR(30) NOT NULL,
    amount INTEGER NOT NULL,

    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,

    reference_type VARCHAR(50),
    reference_id UUID,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- WELCOME BONUS
-- ==========================================

CREATE TABLE IF NOT EXISTS welcome_bonuses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    coins_awarded INTEGER NOT NULL DEFAULT 30,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- TIKTOK ACCOUNTS
-- ==========================================

CREATE TABLE IF NOT EXISTS tiktok_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    open_id VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(100),
    avatar_url TEXT,

    is_verified BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- EARN TASKS
-- ==========================================

CREATE TABLE IF NOT EXISTS earn_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    title VARCHAR(150) NOT NULL,
    description TEXT,

    reward_coins INTEGER NOT NULL CHECK (reward_coins > 0),

    task_type VARCHAR(50) NOT NULL,

    target_url TEXT,

    max_completions INTEGER,

    current_completions INTEGER NOT NULL DEFAULT 0,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- EARN TASK COMPLETIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS earn_completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id UUID NOT NULL REFERENCES earn_tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    reward_coins INTEGER NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'completed',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(task_id, user_id)
);

-- ==========================================
-- PROMOTIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    tiktok_username VARCHAR(100),
    tiktok_url TEXT,

    promotion_type VARCHAR(30) NOT NULL DEFAULT 'followers',

    coins_cost INTEGER NOT NULL CHECK (coins_cost > 0),

    target_count INTEGER NOT NULL CHECK (target_count > 0),
    completed_count INTEGER NOT NULL DEFAULT 0,

    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- PROMOTION TASKS
-- ==========================================

CREATE TABLE IF NOT EXISTS promotion_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    worker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(promotion_id, worker_user_id)
);

-- ==========================================
-- PAYMENTS
-- ==========================================

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    provider VARCHAR(50) NOT NULL,
    reference VARCHAR(255) NOT NULL UNIQUE,

    amount NUMERIC(12,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'NGN',

    coins INTEGER NOT NULL CHECK (coins > 0),

    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    provider_transaction_id VARCHAR(255),

    verified_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- ADMIN ACTIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS admin_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    action VARCHAR(100) NOT NULL,

    target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    details JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_users_tiktok_open_id
ON users(tiktok_open_id);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user_id
ON coin_transactions(user_id);

CREATE INDEX IF NOT EXISTS idx_earn_completions_user_id
ON earn_completions(user_id);

CREATE INDEX IF NOT EXISTS idx_promotion_tasks_worker
ON promotion_tasks(worker_user_id);

CREATE INDEX IF NOT EXISTS idx_promotions_user_id
ON promotions(user_id);

CREATE INDEX IF NOT EXISTS idx_payments_user_id
ON payments(user_id);

CREATE INDEX IF NOT EXISTS idx_payments_reference
ON payments(reference);
-- ==========================================
-- LOGIN SESSIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    session_token_hash VARCHAR(128) NOT NULL UNIQUE,

    expires_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
ON sessions(expires_at);
