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

        promotion_type TEXT NOT NULL
          DEFAULT 'followers',

        coins_cost INTEGER NOT NULL,

        target_count INTEGER NOT NULL,

        completed_count INTEGER NOT NULL
          DEFAULT 0,

        status TEXT NOT NULL
          DEFAULT 'pending',

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW()
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

        status TEXT NOT NULL
          DEFAULT 'pending',

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

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

        reward_coins INTEGER NOT NULL
          DEFAULT 5,

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        UNIQUE(
          task_id,
          user_id
        )
      )
    `);


    /* ==========================================
       FIX ORPHAN coin_packages TYPE
       
       Wannan yana gyara error:
       duplicate key value violates unique constraint
       "pg_type_typename_nsp_index"
       
       Ba ya goge users ko coins.
    ========================================== */

    await client.query(`
      DO $$
      DECLARE
        existing_type TEXT;
      BEGIN

        SELECT t.typtype
        INTO existing_type

        FROM pg_type t

        INNER JOIN pg_namespace n
          ON n.oid = t.typnamespace

        WHERE
          t.typname = 'coin_packages'
          AND n.nspname = 'public'

          AND NOT EXISTS (
            SELECT 1
            FROM pg_class c
            WHERE c.oid = t.typrelid
          )

        LIMIT 1;


        IF existing_type IS NOT NULL THEN

          IF existing_type IN ('c', 'e', 'd') THEN

            EXECUTE 'DROP TYPE IF EXISTS public.coin_packages';

          END IF;

        END IF;

      END
      $$;
    `);


    /* ==========================================
       COIN PACKAGES
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_packages (
        id SERIAL PRIMARY KEY,

        name TEXT NOT NULL,

        coins INTEGER NOT NULL,

        price_amount NUMERIC(12,2) NOT NULL,

        currency TEXT NOT NULL
          DEFAULT 'NGN',

        is_active BOOLEAN NOT NULL
          DEFAULT TRUE,

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW()
      )
    `);


    /* ==========================================
       COIN ORDERS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_orders (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        package_id INTEGER
          REFERENCES coin_packages(id)
          ON DELETE SET NULL,

        order_reference TEXT UNIQUE NOT NULL,

        coins INTEGER NOT NULL,

        amount NUMERIC(12,2) NOT NULL,

        currency TEXT NOT NULL
          DEFAULT 'NGN',

        payment_provider TEXT,

        payment_reference TEXT,

        status TEXT NOT NULL
          DEFAULT 'pending',

        paid_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW()
      )
    `);


    /* ==========================================
       PAYMENTS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        order_id INTEGER
          REFERENCES coin_orders(id)
          ON DELETE SET NULL,

        provider TEXT NOT NULL,

        provider_reference TEXT,

        amount NUMERIC(12,2) NOT NULL,

        currency TEXT NOT NULL
          DEFAULT 'NGN',

        status TEXT NOT NULL
          DEFAULT 'pending',

        payment_method TEXT,

        metadata JSONB,

        paid_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW()
      )
    `);


    /* ==========================================
       ADMIN AUDIT LOGS
    ========================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id SERIAL PRIMARY KEY,

        admin_user_id INTEGER
          REFERENCES users(id)
          ON DELETE SET NULL,

        action TEXT NOT NULL,

        target_user_id INTEGER
          REFERENCES users(id)
          ON DELETE SET NULL,

        reference_type TEXT,

        reference_id TEXT,

        details JSONB,

        created_at TIMESTAMPTZ NOT NULL
          DEFAULT NOW()
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
      CREATE INDEX IF NOT EXISTS idx_coin_transactions_type
      ON coin_transactions(type)
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_coin_orders_user
      ON coin_orders(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_coin_orders_status
      ON coin_orders(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_coin_orders_created
      ON coin_orders(created_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_user
      ON payments(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_status
      ON payments(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_created
      ON payments(created_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_admin
      ON admin_audit_logs(admin_user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_target
      ON admin_audit_logs(target_user_id)
    `);


    /* ==========================================
       MIGRATIONS
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

    console.log(
      "✅ Database tables are ready"
    );

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
