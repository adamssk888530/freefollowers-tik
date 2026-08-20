const { pool } = require("./db");

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* ==========================================
       USERS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,

        tiktok_open_id TEXT UNIQUE NOT NULL,
        tiktok_union_id TEXT,

        display_name TEXT,
        avatar_url TEXT,

        access_token TEXT,
        refresh_token TEXT,

        access_token_expires_at TIMESTAMPTZ,
        refresh_token_expires_at TIMESTAMPTZ,

        coins INTEGER NOT NULL DEFAULT 0,

        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_banned BOOLEAN NOT NULL DEFAULT FALSE,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);


    /* ==========================================
       TIKTOK ACCOUNTS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS tiktok_accounts (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        open_id TEXT UNIQUE NOT NULL,

        username TEXT,
        profile_deep_link TEXT,

        display_name TEXT,
        avatar_url TEXT,

        is_verified BOOLEAN NOT NULL DEFAULT FALSE,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);


    /* ==========================================
       WELCOME BONUSES
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS welcome_bonuses (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        coins_awarded INTEGER NOT NULL DEFAULT 30,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(user_id)
      )
    `);


    /* ==========================================
       COIN TRANSACTIONS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_transactions (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        type TEXT NOT NULL,

        amount INTEGER NOT NULL,

        balance_before INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,

        reference_type TEXT,
        reference_id TEXT,

        description TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);


    /* ==========================================
       SESSIONS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        session_token_hash TEXT UNIQUE NOT NULL,

        expires_at TIMESTAMPTZ NOT NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);


    /* ==========================================
       PROMOTIONS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        tiktok_username TEXT NOT NULL,

        tiktok_url TEXT NOT NULL,

        promotion_type TEXT NOT NULL DEFAULT 'followers',

        coins_cost INTEGER NOT NULL,

        target_count INTEGER NOT NULL,

        completed_count INTEGER NOT NULL DEFAULT 0,

        status TEXT NOT NULL DEFAULT 'pending',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);


    /* ==========================================
       PROMOTION TASKS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_tasks (
        id SERIAL PRIMARY KEY,

        promotion_id INTEGER NOT NULL
          REFERENCES promotions(id)
          ON DELETE CASCADE,

        worker_user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        status TEXT NOT NULL DEFAULT 'pending',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        completed_at TIMESTAMPTZ,

        UNIQUE(
          promotion_id,
          worker_user_id
        )
      )
    `);


    /* ==========================================
       EARN COMPLETIONS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS earn_completions (
        id SERIAL PRIMARY KEY,

        task_id INTEGER NOT NULL
          REFERENCES promotion_tasks(id)
          ON DELETE CASCADE,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        reward_coins INTEGER NOT NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(
          task_id,
          user_id
        )
      )
    `);


    /* ==========================================
       INDEXES
    ========================================== */

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_token
      ON sessions(session_token_hash)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_coin_transactions_user
      ON coin_transactions(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tiktok_accounts_user
      ON tiktok_accounts(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_promotions_user
      ON promotions(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_promotions_status
      ON promotions(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_promotion_tasks_worker
      ON promotion_tasks(worker_user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_promotion_tasks_promotion
      ON promotion_tasks(promotion_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_earn_completions_user
      ON earn_completions(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_earn_completions_task
      ON earn_completions(task_id)
    `);


    /* ==========================================
       MIGRATION FOR EXISTING DATABASES
    ========================================== */

    await client.query(`
      ALTER TABLE tiktok_accounts
      ADD COLUMN IF NOT EXISTS username TEXT
    `);

    await client.query(`
      ALTER TABLE tiktok_accounts
      ADD COLUMN IF NOT EXISTS profile_deep_link TEXT
    `);


    /* ==========================================
       COMMIT
    ========================================== */

    await client.query("COMMIT");

    console.log("✅ Database tables are ready");

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "❌ Database initialization failed:"
    );

    console.error(error);

    throw error;

  } finally {

    client.release();

  }
}


module.exports = {
  initDatabase
};
