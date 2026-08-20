const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();


/* ==========================================
   HELPERS
========================================== */

function parseCookies(cookieHeader = "") {

  const cookies = {};

  cookieHeader.split(";").forEach((item) => {

    const index = item.indexOf("=");

    if (index === -1) return;

    const key =
      item.slice(0, index).trim();

    const value =
      item.slice(index + 1).trim();

    try {
      cookies[key] =
        decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }

  });

  return cookies;
}


function hashToken(token) {

  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

}


/* ==========================================
   CURRENT ADMIN
========================================== */

async function getCurrentAdmin(req) {

  const cookies =
    parseCookies(
      req.headers.cookie || ""
    );

  const sessionToken =
    cookies.session_token;

  if (!sessionToken) {
    return null;
  }

  const sessionHash =
    hashToken(sessionToken);

  const result =
    await query(
      `
      SELECT
        u.id,
        u.display_name,
        u.avatar_url,
        u.coins,
        u.is_active,
        u.is_banned,
        u.is_admin

      FROM sessions s

      INNER JOIN users u
        ON u.id = s.user_id

      WHERE
        s.session_token_hash = $1

        AND s.expires_at > NOW()

      LIMIT 1
      `,
      [sessionHash]
    );

  if (result.rows.length === 0) {
    return null;
  }

  const admin =
    result.rows[0];

  if (
    !admin.is_active ||
    admin.is_banned ||
    !admin.is_admin
  ) {
    return null;
  }

  return admin;
}


/* ==========================================
   ADMIN MIDDLEWARE
========================================== */

async function requireAdmin(
  req,
  res,
  next
) {

  try {

    const admin =
      await getCurrentAdmin(req);

    if (!admin) {

      return res.status(403).json({
        success: false,
        message:
          "Admin access required"
      });

    }

    req.admin = admin;

    next();

  } catch (error) {

    console.error(
      "Admin authentication error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Could not authenticate admin"
    });

  }

}


/* ==========================================
   1. ADMIN ME
========================================== */

router.get(
  "/admin/me",
  requireAdmin,
  async (req, res) => {

    return res.json({

      success: true,

      admin: {

        id:
          req.admin.id,

        display_name:
          req.admin.display_name,

        avatar_url:
          req.admin.avatar_url,

        coins:
          Number(req.admin.coins || 0),

        is_admin:
          req.admin.is_admin

      }

    });

  }
);


/* ==========================================
   2. ADMIN STATS
========================================== */

router.get(
  "/admin/stats",
  requireAdmin,
  async (req, res) => {

    try {

      /* USERS */

      const usersResult =
        await query(`
          SELECT

            COUNT(*)::INTEGER
              AS total_users,

            COUNT(*) FILTER (
              WHERE
                is_active = TRUE
                AND is_banned = FALSE
            )::INTEGER
              AS active_users,

            COUNT(*) FILTER (
              WHERE is_banned = TRUE
            )::INTEGER
              AS banned_users,

            COUNT(*) FILTER (
              WHERE created_at >= CURRENT_DATE
            )::INTEGER
              AS new_users_today

          FROM users
        `);


      /* COINS */

      const coinsResult =
        await query(`
          SELECT

            COALESCE(
              SUM(coins),
              0
            )::BIGINT
              AS total_user_coins

          FROM users
        `);


      /* SALES */

      const ordersResult =
        await query(`
          SELECT

            COUNT(*) FILTER (
              WHERE status = 'paid'
            )::INTEGER
              AS paid_orders,

            COUNT(*) FILTER (
              WHERE status = 'pending'
            )::INTEGER
              AS pending_orders,

            COUNT(*) FILTER (
              WHERE status = 'failed'
            )::INTEGER
              AS failed_orders,

            COALESCE(
              SUM(coins)
              FILTER (
                WHERE status = 'paid'
              ),
              0
            )::BIGINT
              AS coins_sold,

            COALESCE(
              SUM(amount)
              FILTER (
                WHERE status = 'paid'
              ),
              0
            )::NUMERIC
              AS revenue

          FROM coin_orders
        `);


      /* TODAY */

      const todaySalesResult =
        await query(`
          SELECT

            COUNT(*)::INTEGER
              AS orders_today,

            COALESCE(
              SUM(coins),
              0
            )::BIGINT
              AS coins_today,

            COALESCE(
              SUM(amount),
              0
            )::NUMERIC
              AS revenue_today

          FROM coin_orders

          WHERE
            status = 'paid'

            AND created_at >= CURRENT_DATE
        `);


      /* PROMOTIONS */

      const promotionsResult =
        await query(`
          SELECT

            COUNT(*)::INTEGER
              AS total_promotions,

            COUNT(*) FILTER (
              WHERE status = 'pending'
            )::INTEGER
              AS pending_promotions,

            COUNT(*) FILTER (
              WHERE status = 'completed'
            )::INTEGER
              AS completed_promotions,

            COALESCE(
              SUM(coins_cost),
              0
            )::BIGINT
              AS coins_spent_on_promotions

          FROM promotions
        `);


      /* TASKS */

      const tasksResult =
        await query(`
          SELECT

            COUNT(*)::INTEGER
              AS total_tasks,

            COUNT(*) FILTER (
              WHERE status = 'pending'
            )::INTEGER
              AS pending_tasks,

            COUNT(*) FILTER (
              WHERE status = 'completed'
            )::INTEGER
              AS completed_tasks

          FROM promotion_tasks
        `);


      /* EARN */

      const rewardsResult =
        await query(`
          SELECT

            COUNT(*)::INTEGER
              AS completed_earn_tasks,

            COALESCE(
              SUM(reward_coins),
              0
            )::BIGINT
              AS coins_given_as_rewards

          FROM earn_completions
        `);


      /* TRANSACTIONS */

      const transactionsResult =
        await query(`
          SELECT

            COUNT(*)::INTEGER
              AS total_transactions,

            COALESCE(
              SUM(
                CASE
                  WHEN amount > 0
                  THEN amount
                  ELSE 0
                END
              ),
              0
            )::BIGINT
              AS coins_added,

            COALESCE(
              SUM(
                CASE
                  WHEN amount < 0
                  THEN ABS(amount)
                  ELSE 0
                END
              ),
              0
            )::BIGINT
              AS coins_removed

          FROM coin_transactions
        `);


      const users =
        usersResult.rows[0];

      const coins =
        coinsResult.rows[0];

      const orders =
        ordersResult.rows[0];

      const today =
        todaySalesResult.rows[0];

      const promotions =
        promotionsResult.rows[0];

      const tasks =
        tasksResult.rows[0];

      const rewards =
        rewardsResult.rows[0];

      const transactions =
        transactionsResult.rows[0];


      return res.json({

        success: true,

        users: {

          total:
            Number(users.total_users),

          active:
            Number(users.active_users),

          banned:
            Number(users.banned_users),

          new_today:
            Number(users.new_users_today)

        },

        coins: {

          total_user_coins:
            Number(
              coins.total_user_coins
            ),

          sold:
            Number(
              orders.coins_sold
            ),

          spent_on_promotions:
            Number(
              promotions.coins_spent_on_promotions
            ),

          given_as_rewards:
            Number(
              rewards.coins_given_as_rewards
            )

        },

        sales: {

          paid_orders:
            Number(
              orders.paid_orders
            ),

          pending_orders:
            Number(
              orders.pending_orders
            ),

          failed_orders:
            Number(
              orders.failed_orders
            ),

          revenue:
            Number(
              orders.revenue
            ),

          today: {

            orders:
              Number(
                today.orders_today
              ),

            coins:
              Number(
                today.coins_today
              ),

            revenue:
              Number(
                today.revenue_today
              )

          }

        },

        promotions: {

          total:
            Number(
              promotions.total_promotions
            ),

          pending:
            Number(
              promotions.pending_promotions
            ),

          completed:
            Number(
              promotions.completed_promotions
            ),

          coins_spent:
            Number(
              promotions.coins_spent_on_promotions
            )

        },

        tasks: {

          total:
            Number(
              tasks.total_tasks
            ),

          pending:
            Number(
              tasks.pending_tasks
            ),

          completed:
            Number(
              tasks.completed_tasks
            )

        },

        rewards: {

          completed_tasks:
            Number(
              rewards.completed_earn_tasks
            ),

          coins_given:
            Number(
              rewards.coins_given_as_rewards
            )

        },

        transactions: {

          total:
            Number(
              transactions.total_transactions
            ),

          coins_added:
            Number(
              transactions.coins_added
            ),

          coins_removed:
            Number(
              transactions.coins_removed
            )

        }

      });

    } catch (error) {

      console.error(
        "Admin stats error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load admin statistics"

      });

    }

  }
);


/* ==========================================
   3. USERS
========================================== */

router.get(
  "/admin/users",
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await query(`
          SELECT

            u.id,

            u.display_name,

            u.avatar_url,

            u.coins,

            u.is_active,

            u.is_banned,

            u.is_admin,

            u.created_at,

            ta.username
              AS tiktok_username

          FROM users u

          LEFT JOIN tiktok_accounts ta
            ON ta.user_id = u.id

          ORDER BY
            u.created_at DESC

          LIMIT 100
        `);

      return res.json({

        success: true,

        users:
          result.rows

      });

    } catch (error) {

      console.error(
        "Admin users error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load users"

      });

    }

  }
);


/* ==========================================
   4. TRANSACTIONS
========================================== */

router.get(
  "/admin/transactions",
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await query(`
          SELECT

            ct.id,

            ct.user_id,

            u.display_name,

            ct.type,

            ct.amount,

            ct.balance_before,

            ct.balance_after,

            ct.reference_type,

            ct.reference_id,

            ct.description,

            ct.created_at

          FROM coin_transactions ct

          INNER JOIN users u
            ON u.id = ct.user_id

          ORDER BY
            ct.created_at DESC

          LIMIT 100
        `);

      return res.json({

        success: true,

        transactions:
          result.rows

      });

    } catch (error) {

      console.error(
        "Admin transactions error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load transactions"

      });

    }

  }
);


/* ==========================================
   5. COIN ORDERS
========================================== */

router.get(
  "/admin/orders",
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await query(`
          SELECT

            co.id,

            co.order_reference,

            co.user_id,

            u.display_name,

            co.coins,

            co.amount,

            co.currency,

            co.payment_provider,

            co.payment_reference,

            co.status,

            co.paid_at,

            co.created_at

          FROM coin_orders co

          INNER JOIN users u
            ON u.id = co.user_id

          ORDER BY
            co.created_at DESC

          LIMIT 200
        `);

      return res.json({

        success: true,

        orders:
          result.rows

      });

    } catch (error) {

      console.error(
        "Admin orders error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load coin orders"

      });

    }

  }
);


/* ==========================================
   6. PROMOTIONS
========================================== */

router.get(
  "/admin/promotions",
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await query(`
          SELECT

            p.id,

            p.user_id,

            u.display_name,

            p.tiktok_username,

            p.tiktok_url,

            p.promotion_type,

            p.coins_cost,

            p.target_count,

            p.completed_count,

            p.status,

            p.created_at,

            p.updated_at

          FROM promotions p

          INNER JOIN users u
            ON u.id = p.user_id

          ORDER BY
            p.created_at DESC

          LIMIT 200
        `);

      return res.json({

        success: true,

        promotions:
          result.rows

      });

    } catch (error) {

      console.error(
        "Admin promotions error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load promotions"

      });

    }

  }
);


/* ==========================================
   7. ADD COINS
========================================== */

router.post(
  "/admin/users/:userId/add-coins",
  requireAdmin,
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const userId =
        Number(
          req.params.userId
        );

      const amount =
        Number(
          req.body.amount
        );


      /* VALIDATE USER ID */

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user ID"

        });

      }


      /* VALIDATE COINS */

      if (
        !Number.isInteger(amount) ||
        amount <= 0 ||
        amount > 1000000
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Coin amount must be between 1 and 1,000,000"

        });

      }


      await client.query(
        "BEGIN"
      );


      /* LOCK USER */

      const userResult =
        await client.query(
          `
          SELECT
            id,
            display_name,
            coins,
            is_active,
            is_banned

          FROM users

          WHERE id = $1

          FOR UPDATE
          `,
          [userId]
        );


      if (
        userResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          success: false,

          message:
            "User not found"

        });

      }


      const user =
        userResult.rows[0];


      const balanceBefore =
        Number(
          user.coins || 0
        );


      const balanceAfter =
        balanceBefore + amount;


      /* UPDATE BALANCE */

      const updateResult =
        await client.query(
          `
          UPDATE users

          SET

            coins =
              coins + $1,

            updated_at =
              NOW()

          WHERE
            id = $2

          RETURNING
            id,
            display_name,
            coins
          `,
          [
            amount,
            userId
          ]
        );


      if (
        updateResult.rows.length === 0
      ) {

        throw new Error(
          "Could not update user coins"
        );

      }


      const updatedUser =
        updateResult.rows[0];


      /* TRANSACTION */

      await client.query(
        `
        INSERT INTO coin_transactions (
          user_id,
          type,
          amount,
          balance_before,
          balance_after,
          reference_type,
          reference_id,
          description
        )

        VALUES (
          $1,
          'admin_credit',
          $2,
          $3,
          $4,
          'admin',
          $5,
          $6
        )
        `,
        [
          userId,

          amount,

          balanceBefore,

          Number(
            updatedUser.coins
          ),

          String(
            req.admin.id
          ),

          `Admin added ${amount} coins`
        ]
      );


      /* AUDIT LOG */

      await client.query(
        `
        INSERT INTO admin_audit_logs (
          admin_user_id,
          action,
          target_user_id,
          reference_type,
          reference_id,
          details
        )

        VALUES (
          $1,
          'add_coins',
          $2,
          'user',
          $3,
          $4
        )
        `,
        [
          req.admin.id,

          userId,

          String(userId),

          JSON.stringify({

            amount,

            balance_before:
              balanceBefore,

            balance_after:
              Number(
                updatedUser.coins
              )

          })

        ]
      );


      await client.query(
        "COMMIT"
      );


      return res.json({

        success: true,

        message:
          `Successfully added ${amount} coins`,

        user: {

          id:
            updatedUser.id,

          display_name:
            updatedUser.display_name,

          coins:
            Number(
              updatedUser.coins
            )

        },

        transaction: {

          amount,

          balance_before:
            balanceBefore,

          balance_after:
            Number(
              updatedUser.coins
            )

        }

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Admin add coins error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not add coins"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   8. USER DETAILS
========================================== */

router.get(
  "/admin/users/:userId",
  requireAdmin,
  async (req, res) => {

    try {

      const userId =
        Number(
          req.params.userId
        );

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid user ID"

        });

      }


      const userResult =
        await query(
          `
          SELECT

            u.id,

            u.display_name,

            u.avatar_url,

            u.coins,

            u.is_active,

            u.is_banned,

            u.is_admin,

            u.created_at,

            u.updated_at,

            ta.username
              AS tiktok_username,

            ta.profile_deep_link,

            ta.is_verified

          FROM users u

          LEFT JOIN tiktok_accounts ta
            ON ta.user_id = u.id

          WHERE
            u.id = $1

          LIMIT 1
          `,
          [userId]
        );


      if (
        userResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "User not found"

        });

      }


      const transactionsResult =
        await query(
          `
          SELECT

            id,

            type,

            amount,

            balance_before,

            balance_after,

            reference_type,

            reference_id,

            description,

            created_at

          FROM coin_transactions

          WHERE
            user_id = $1

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [userId]
        );


      const promotionsResult =
        await query(
          `
          SELECT

            id,

            tiktok_username,

            tiktok_url,

            promotion_type,

            coins_cost,

            target_count,

            completed_count,

            status,

            created_at,

            updated_at

          FROM promotions

          WHERE
            user_id = $1

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [userId]
        );


      return res.json({

        success: true,

        user:
          userResult.rows[0],

        transactions:
          transactionsResult.rows,

        promotions:
          promotionsResult.rows

      });

    } catch (error) {

      console.error(
        "Admin user details error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load user details"

      });

    }

  }
);


/* ==========================================
   EXPORT
========================================== */

module.exports = router;
