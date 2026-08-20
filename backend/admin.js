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

    req.admin =
      admin;

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
   ADMIN AUDIT HELPER
========================================== */

async function writeAuditLog(
  client,
  adminId,
  action,
  targetUserId = null,
  referenceType = null,
  referenceId = null,
  details = {}
) {

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
      $2,
      $3,
      $4,
      $5,
      $6
    )
    `,
    [
      adminId,
      action,
      targetUserId,
      referenceType,
      referenceId,
      JSON.stringify(details)
    ]
  );

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
          Number(
            req.admin.coins || 0
          ),

        is_admin:
          req.admin.is_admin

      }

    });

  }
);


/* ==========================================
   2. ADMIN DASHBOARD STATS
========================================== */

router.get(
  "/admin/stats",
  requireAdmin,
  async (req, res) => {

    try {

      /* ======================================
         USERS
      ====================================== */

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


      /* ======================================
         COINS
      ====================================== */

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


      /* ======================================
         COIN ORDERS
      ====================================== */

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


      /* ======================================
         TODAY SALES
      ====================================== */

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


      /* ======================================
         PROMOTIONS
      ====================================== */

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


      /* ======================================
         TASKS
      ====================================== */

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


      /* ======================================
         EARN REWARDS
      ====================================== */

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


      /* ======================================
         TRANSACTIONS
      ====================================== */

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
            Number(
              users.total_users
            ),

          active:
            Number(
              users.active_users
            ),

          banned:
            Number(
              users.banned_users
            ),

          new_today:
            Number(
              users.new_users_today
            )

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
   3. USERS LIST
========================================== */

router.get(
  "/admin/users",
  requireAdmin,
  async (req, res) => {

    try {

      const search =
        String(
          req.query.search || ""
        ).trim();


      let result;


      if (search) {

        result =
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

              ta.username
                AS tiktok_username

            FROM users u

            LEFT JOIN tiktok_accounts ta
              ON ta.user_id = u.id

            WHERE

              CAST(u.id AS TEXT)
                ILIKE $1

              OR COALESCE(
                u.display_name,
                ''
              )
                ILIKE $1

              OR COALESCE(
                ta.username,
                ''
              )
                ILIKE $1

            ORDER BY
              u.created_at DESC

            LIMIT 100
            `,
            [`%${search}%`]
          );

      } else {

        result =
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

      }


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
   4. USER DETAILS
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


      const ordersResult =
        await query(
          `
          SELECT

            id,

            order_reference,

            coins,

            amount,

            currency,

            payment_provider,

            payment_reference,

            status,

            paid_at,

            created_at

          FROM coin_orders

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
          promotionsResult.rows,

        orders:
          ordersResult.rows

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
   5. ADD COINS
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


      const updatedUser =
        updateResult.rows[0];


      const balanceAfter =
        Number(
          updatedUser.coins
        );


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
          balanceAfter,
          String(req.admin.id),
          `Admin added ${amount} coins`
        ]
      );


      await writeAuditLog(
        client,
        req.admin.id,
        "add_coins",
        userId,
        "user",
        String(userId),
        {
          amount,
          balance_before:
            balanceBefore,
          balance_after:
            balanceAfter
        }
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
            balanceAfter

        },

        transaction: {

          amount,

          balance_before:
            balanceBefore,

          balance_after:
            balanceAfter

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
   6. REMOVE COINS
========================================== */

router.post(
  "/admin/users/:userId/remove-coins",
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


      const userResult =
        await client.query(
          `
          SELECT

            id,

            display_name,

            coins

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


      if (
        amount > balanceBefore
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            "User does not have enough coins"

        });

      }


      const updateResult =
        await client.query(
          `
          UPDATE users

          SET

            coins =
              coins - $1,

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


      const updatedUser =
        updateResult.rows[0];


      const balanceAfter =
        Number(
          updatedUser.coins
        );


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
          'admin_debit',
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

          -amount,

          balanceBefore,

          balanceAfter,

          String(
            req.admin.id
          ),

          `Admin removed ${amount} coins`
        ]
      );


      await writeAuditLog(
        client,
        req.admin.id,
        "remove_coins",
        userId,
        "user",
        String(userId),
        {
          amount,
          balance_before:
            balanceBefore,
          balance_after:
            balanceAfter
        }
      );


      await client.query(
        "COMMIT"
      );


      return res.json({

        success: true,

        message:
          `Successfully removed ${amount} coins`,

        user: {

          id:
            updatedUser.id,

          display_name:
            updatedUser.display_name,

          coins:
            balanceAfter

        },

        transaction: {

          amount:
            -amount,

          balance_before:
            balanceBefore,

          balance_after:
            balanceAfter

        }

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Admin remove coins error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not remove coins"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   7. BAN / UNBAN USER
========================================== */

router.post(
  "/admin/users/:userId/ban",
  requireAdmin,
  async (req, res) => {

    const client =
      await pool.connect();

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


      if (
        userId ===
        Number(req.admin.id)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Admin cannot ban their own account"

        });

      }


      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(
          `
          UPDATE users

          SET

            is_banned =
              TRUE,

            updated_at =
              NOW()

          WHERE
            id = $1

          RETURNING

            id,

            display_name,

            is_banned
          `,
          [userId]
        );


      if (
        result.rows.length === 0
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


      await writeAuditLog(
        client,
        req.admin.id,
        "ban_user",
        userId,
        "user",
        String(userId),
        {
          banned: true
        }
      );


      await client.query(
        "COMMIT"
      );


      return res.json({

        success: true,

        message:
          "User has been banned",

        user:
          result.rows[0]

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Admin ban user error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not ban user"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   8. UNBAN USER
========================================== */

router.post(
  "/admin/users/:userId/unban",
  requireAdmin,
  async (req, res) => {

    const client =
      await pool.connect();

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


      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(
          `
          UPDATE users

          SET

            is_banned =
              FALSE,

            updated_at =
              NOW()

          WHERE
            id = $1

          RETURNING

            id,

            display_name,

            is_banned
          `,
          [userId]
        );


      if (
        result.rows.length === 0
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


      await writeAuditLog(
        client,
        req.admin.id,
        "unban_user",
        userId,
        "user",
        String(userId),
        {
          banned: false
        }
      );


      await client.query(
        "COMMIT"
      );


      return res.json({

        success: true,

        message:
          "User has been unbanned",

        user:
          result.rows[0]

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Admin unban user error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not unban user"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   9. ACTIVATE USER
========================================== */

router.post(
  "/admin/users/:userId/activate",
  requireAdmin,
  async (req, res) => {

    const client =
      await pool.connect();

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


      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(
          `
          UPDATE users

          SET

            is_active =
              TRUE,

            updated_at =
              NOW()

          WHERE
            id = $1

          RETURNING

            id,

            display_name,

            is_active
          `,
          [userId]
        );


      if (
        result.rows.length === 0
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


      await writeAuditLog(
        client,
        req.admin.id,
        "activate_user",
        userId,
        "user",
        String(userId),
        {
          active: true
        }
      );


      await client.query(
        "COMMIT"
      );


      return res.json({

        success: true,

        message:
          "User account activated",

        user:
          result.rows[0]

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Admin activate user error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not activate user"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   10. DEACTIVATE USER
========================================== */

router.post(
  "/admin/users/:userId/deactivate",
  requireAdmin,
  async (req, res) => {

    const client =
      await pool.connect();

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


      if (
        userId ===
        Number(req.admin.id)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Admin cannot deactivate their own account"

        });

      }


      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(
          `
          UPDATE users

          SET

            is_active =
              FALSE,

            updated_at =
              NOW()

          WHERE
            id = $1

          RETURNING

            id,

            display_name,

            is_active
          `,
          [userId]
        );


      if (
        result.rows.length === 0
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


      await writeAuditLog(
        client,
        req.admin.id,
        "deactivate_user",
        userId,
        "user",
        String(userId),
        {
          active: false
        }
      );


      await client.query(
        "COMMIT"
      );


      return res.json({

        success: true,

        message:
          "User account deactivated",

        user:
          result.rows[0]

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}

      console.error(
        "Admin deactivate user error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not deactivate user"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   11. TRANSACTIONS
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
   12. COIN ORDERS
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
   13. PROMOTIONS
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
   14. ADMIN AUDIT LOGS
========================================== */

router.get(
  "/admin/audit-logs",
  requireAdmin,
  async (req, res) => {

    try {

      const result =
        await query(`
          SELECT

            aal.id,

            aal.action,

            aal.target_user_id,

            target.display_name
              AS target_user_name,

            aal.reference_type,

            aal.reference_id,

            aal.details,

            aal.created_at

          FROM admin_audit_logs aal

          LEFT JOIN users target
            ON target.id =
              aal.target_user_id

          WHERE
            aal.admin_user_id =
              $1

          ORDER BY
            aal.created_at DESC

          LIMIT 200
        `,
        [
          req.admin.id
        ]);


      return res.json({

        success: true,

        logs:
          result.rows

      });

    } catch (error) {

      console.error(
        "Admin audit logs error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not load audit logs"

      });

    }

  }
);


/* ==========================================
   EXPORT
========================================== */

module.exports = router;
