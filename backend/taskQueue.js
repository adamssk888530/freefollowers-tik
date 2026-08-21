const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const TASK_REWARD_COINS = 5;
const MAX_TASKS_PER_REQUEST = 20;

const TIKTOK_RESEARCH_FOLLOWING_URL =
  "https://open.tiktokapis.com/v2/research/user/following/";

/* =========================================================
   HELPERS
========================================================= */

function parseCookies(cookieHeader = "") {
  const cookies = {};

  cookieHeader.split(";").forEach((item) => {
    const index = item.indexOf("=");

    if (index === -1) return;

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();

    try {
      cookies[key] = decodeURIComponent(value);
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


/* =========================================================
   CURRENT USER
========================================================= */

async function getCurrentUser(req) {
  const cookies = parseCookies(
    req.headers.cookie || ""
  );

  const sessionToken =
    cookies.session_token;

  if (!sessionToken) {
    return null;
  }

  const sessionHash =
    hashToken(sessionToken);

  const result = await query(
    `
    SELECT
      u.id,
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

  const user = result.rows[0];

  if (
    !user.is_active ||
    user.is_banned
  ) {
    return null;
  }

  return user;
}


/* =========================================================
   TIKTOK USERNAME CLEANER
========================================================= */

function cleanUsername(username) {
  return String(username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}


/* =========================================================
   VERIFY TIKTOK FOLLOW
========================================================= */

async function verifyFollowing(
  workerUsername,
  targetUsername
) {
  const researchToken =
    process.env.TIKTOK_RESEARCH_ACCESS_TOKEN;

  if (!researchToken) {
    return {
      verified: false,
      available: false,
      reason:
        "TikTok Research API access token is not configured"
    };
  }

  const worker =
    cleanUsername(workerUsername);

  const target =
    cleanUsername(targetUsername);

  if (!worker || !target) {
    return {
      verified: false,
      available: true,
      reason:
        "TikTok username is missing"
    };
  }

  let cursor = null;

  const maxPages = 50;

  for (
    let page = 0;
    page < maxPages;
    page++
  ) {
    const body = {
      username: worker,
      max_count: 100
    };

    if (cursor !== null) {
      body.cursor = cursor;
    }

    let response;

    try {
      response = await fetch(
        TIKTOK_RESEARCH_FOLLOWING_URL,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${researchToken}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(body)
        }
      );
    } catch (error) {
      console.error(
        "TikTok API network error:",
        error
      );

      return {
        verified: false,
        available: true,
        reason:
          "Could not connect to TikTok verification service"
      };
    }

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      console.error(
        "TikTok Research API error:",
        data
      );

      return {
        verified: false,
        available: true,
        reason:
          data?.error?.message ||
          "TikTok verification request failed"
      };
    }

    const following =
      data?.data?.user_following || [];

    const found =
      following.some((account) => {
        const username =
          cleanUsername(
            account?.username
          );

        return username === target;
      });

    if (found) {
      return {
        verified: true,
        available: true,
        reason:
          "Target account found in following list"
      };
    }

    const hasMore =
      Boolean(
        data?.data?.has_more
      );

    if (!hasMore) {
      break;
    }

    cursor =
      data?.data?.cursor;

    if (
      cursor === null ||
      cursor === undefined
    ) {
      break;
    }
  }

  return {
    verified: false,
    available: true,
    reason:
      "Target account was not found in following list"
  };
}


/* =========================================================
   1. GET NEXT TASK
========================================================= */

router.get(
  "/task-queue/next",
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Not logged in"
        });
      }

      await client.query("BEGIN");

      const result =
        await client.query(
          `
          SELECT
            pt.id AS task_id,

            p.id AS promotion_id,

            p.user_id AS promotion_owner_id,

            p.tiktok_username,

            p.tiktok_url,

            p.promotion_type,

            p.completed_count,

            p.target_count,

            pt.status,

            pt.created_at

          FROM promotion_tasks pt

          INNER JOIN promotions p
            ON p.id = pt.promotion_id

          WHERE
            pt.worker_user_id = $1

            AND pt.status = 'pending'

            AND p.status = 'pending'

            AND p.completed_count <
                p.target_count

          ORDER BY
            pt.created_at ASC

          LIMIT 1

          FOR UPDATE OF pt
          `,
          [user.id]
        );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.json({
          success: true,
          has_task: false,
          task: null,
          message:
            "No task available"
        });
      }

      const task =
        result.rows[0];

      await client.query("COMMIT");

      return res.json({
        success: true,

        has_task: true,

        task: {
          id:
            task.task_id,

          promotion_id:
            task.promotion_id,

          tiktok_username:
            task.tiktok_username,

          tiktok_url:
            task.tiktok_url,

          promotion_type:
            task.promotion_type,

          reward_coins:
            TASK_REWARD_COINS,

          progress: {
            completed:
              Number(
                task.completed_count
              ),

            target:
              Number(
                task.target_count
              )
          }
        }
      });

    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Get next task error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not get next task"
      });

    } finally {
      client.release();
    }
  }
);


/* =========================================================
   2. VERIFY TASK
========================================================= */

router.post(
  "/task-queue/verify",
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message:
            "Not logged in"
        });
      }

      const taskId =
        String(
          req.body?.task_id || ""
        ).trim();

      if (!taskId) {
        return res.status(400).json({
          success: false,
          message:
            "Task ID is required"
        });
      }

      await client.query("BEGIN");


      /* =====================================================
         LOCK TASK + PROMOTION
      ===================================================== */

      const taskResult =
        await client.query(
          `
          SELECT

            pt.id AS task_id,

            pt.worker_user_id,

            pt.status AS task_status,

            p.id AS promotion_id,

            p.user_id AS promotion_owner_id,

            p.status AS promotion_status,

            p.tiktok_username,

            p.tiktok_url,

            p.promotion_type,

            p.completed_count,

            p.target_count

          FROM promotion_tasks pt

          INNER JOIN promotions p
            ON p.id = pt.promotion_id

          WHERE
            pt.id = $1

            AND pt.worker_user_id = $2

          LIMIT 1

          FOR UPDATE OF pt
          `,
          [
            taskId,
            user.id
          ]
        );

      if (
        taskResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message:
            "Task not found"
        });
      }

      const task =
        taskResult.rows[0];


      /* =====================================================
         TASK STATUS
      ===================================================== */

      if (
        task.task_status !==
        "pending"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "This task has already been completed"
        });
      }


      /* =====================================================
         PROMOTION STATUS
      ===================================================== */

      if (
        task.promotion_status !==
        "pending"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "This promotion is no longer active"
        });
      }


      if (
        Number(task.completed_count) >=
        Number(task.target_count)
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "This promotion is already complete"
        });
      }


      /* =====================================================
         GET WORKER TIKTOK ACCOUNT
      ===================================================== */

      const workerAccountResult =
        await client.query(
          `
          SELECT
            id,
            username,
            profile_deep_link,
            display_name,
            avatar_url

          FROM tiktok_accounts

          WHERE
            user_id = $1

            AND username IS NOT NULL

          ORDER BY
            updated_at DESC

          LIMIT 1
          `,
          [user.id]
        );

      if (
        workerAccountResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Your TikTok account is not connected. Please login with TikTok again."
        });
      }

      const workerAccount =
        workerAccountResult.rows[0];

      const workerUsername =
        workerAccount.username;


      /* =====================================================
         VERIFY FOLLOW
      ===================================================== */

      const verification =
        await verifyFollowing(
          workerUsername,
          task.tiktok_username
        );


      /* =====================================================
         RESEARCH API NOT AVAILABLE
      ===================================================== */

      if (
        !verification.available
      ) {
        await client.query("ROLLBACK");

        return res.status(503).json({
          success: false,
          verified: false,

          message:
            "TikTok follow verification is not configured yet.",

          details:
            verification.reason
        });
      }


      /* =====================================================
         FOLLOW NOT VERIFIED
      ===================================================== */

      if (
        !verification.verified
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          verified: false,

          message:
            "Follow verification failed. Please follow the TikTok account first.",

          details:
            verification.reason
        });
      }


      /* =====================================================
         LOCK USER WALLET
      ===================================================== */

      const userResult =
        await client.query(
          `
          SELECT
            id,
            coins,
            is_active,
            is_banned

          FROM users

          WHERE id = $1

          FOR UPDATE
          `,
          [user.id]
        );

      if (
        userResult.rows.length === 0
      ) {
        throw new Error(
          "User could not be loaded"
        );
      }

      const lockedUser =
        userResult.rows[0];

      if (
        !lockedUser.is_active ||
        lockedUser.is_banned
      ) {
        await client.query("ROLLBACK");

        return res.status(403).json({
          success: false,
          message:
            "Account is not active"
        });
      }

      const balanceBefore =
        Number(
          lockedUser.coins || 0
        );


      /* =====================================================
         DUPLICATE REWARD PROTECTION
      ===================================================== */

      const completionResult =
        await client.query(
          `
          INSERT INTO earn_completions (
            task_id,
            user_id,
            reward_coins
          )

          VALUES (
            $1,
            $2,
            $3
          )

          ON CONFLICT (
            task_id,
            user_id
          )

          DO NOTHING

          RETURNING id
          `,
          [
            task.task_id,
            user.id,
            TASK_REWARD_COINS
          ]
        );

      if (
        completionResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "This task has already received a reward"
        });
      }


      /* =====================================================
         COMPLETE TASK
      ===================================================== */

      const completedTaskResult =
        await client.query(
          `
          UPDATE promotion_tasks

          SET
            status = 'completed',
            completed_at = NOW()

          WHERE
            id = $1

            AND worker_user_id = $2

            AND status = 'pending'

          RETURNING id
          `,
          [
            task.task_id,
            user.id
          ]
        );

      if (
        completedTaskResult.rows.length === 0
      ) {
        throw new Error(
          "Task could not be completed"
        );
      }


      /* =====================================================
         UPDATE PROMOTION
      ===================================================== */

      const promotionUpdate =
        await client.query(
          `
          UPDATE promotions

          SET
            completed_count =
              completed_count + 1,

            status =
              CASE
                WHEN completed_count + 1 >= target_count
                THEN 'completed'

                ELSE status
              END,

            updated_at = NOW()

          WHERE
            id = $1

            AND completed_count <
                target_count

          RETURNING
            completed_count,
            target_count,
            status
          `,
          [task.promotion_id]
        );

      if (
        promotionUpdate.rows.length === 0
      ) {
        throw new Error(
          "Promotion could not be updated"
        );
      }

      const promotion =
        promotionUpdate.rows[0];


      /* =====================================================
         ADD REWARD TO WALLET
      ===================================================== */

      const walletResult =
        await client.query(
          `
          UPDATE users

          SET
            coins =
              coins + $2,

            updated_at =
              NOW()

          WHERE
            id = $1

          RETURNING coins
          `,
          [
            user.id,
            TASK_REWARD_COINS
          ]
        );

      if (
        walletResult.rows.length === 0
      ) {
        throw new Error(
          "Could not update wallet"
        );
      }

      const newBalance =
        Number(
          walletResult.rows[0].coins
        );


      /* =====================================================
         COIN TRANSACTION
      ===================================================== */

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

          'task_reward',

          $2,

          $3,

          $4,

          'promotion_task',

          $5,

          $6

        )
        `,
        [
          user.id,

          TASK_REWARD_COINS,

          balanceBefore,

          newBalance,

          String(task.task_id),

          "Reward for verified TikTok promotion task"
        ]
      );


      /* =====================================================
         COMMIT
      ===================================================== */

      await client.query("COMMIT");


      return res.json({

        success: true,

        verified: true,

        message:
          "Task verified successfully. +5 coins added.",

        reward_coins:
          TASK_REWARD_COINS,

        coins:
          newBalance,

        task: {
          id:
            task.task_id,

          status:
            "completed"
        },

        promotion: {
          completed:
            Number(
              promotion.completed_count
            ),

          target:
            Number(
              promotion.target_count
            ),

          status:
            promotion.status
        }
      });

    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Verify task error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not verify task"
      });

    } finally {
      client.release();
    }
  }
);


/* =========================================================
   3. ASSIGN TASKS
   ADMIN ONLY
========================================================= */

router.post(
  "/task-queue/assign",
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message:
            "Not logged in"
        });
      }

      if (!user.is_admin) {
        return res.status(403).json({
          success: false,
          message:
            "Admin access required"
        });
      }

      const requestedLimit =
        Number(
          req.body?.limit ||
          MAX_TASKS_PER_REQUEST
        );

      const limit =
        Math.min(
          Math.max(
            Number.isInteger(
              requestedLimit
            )
              ? requestedLimit
              : MAX_TASKS_PER_REQUEST,
            1
          ),
          MAX_TASKS_PER_REQUEST
        );

      await client.query("BEGIN");


      /* =====================================================
         FIND ACTIVE PROMOTIONS
      ===================================================== */

      const promotionsResult =
        await client.query(
          `
          SELECT
            id,
            user_id,
            target_count,
            completed_count

          FROM promotions

          WHERE
            status = 'pending'

            AND completed_count <
                target_count

          ORDER BY
            created_at ASC

          LIMIT 20

          FOR UPDATE
          `
        );

      let assigned = 0;


      /* =====================================================
         ASSIGN WORKERS
      ===================================================== */

      for (
        const promotion
        of promotionsResult.rows
      ) {
        if (
          assigned >= limit
        ) {
          break;
        }

        const remaining =
          Number(
            promotion.target_count
          ) -
          Number(
            promotion.completed_count
          );

        if (remaining <= 0) {
          continue;
        }

        const workersLimit =
          Math.min(
            remaining,
            limit - assigned
          );

        if (workersLimit <= 0) {
          continue;
        }


        const workersResult =
          await client.query(
            `
            SELECT
              u.id

            FROM users u

            WHERE
              u.is_active = TRUE

              AND u.is_banned = FALSE

              AND u.id <> $1

              AND EXISTS (
                SELECT 1

                FROM tiktok_accounts ta

                WHERE
                  ta.user_id = u.id

                  AND ta.username IS NOT NULL
              )

              AND NOT EXISTS (
                SELECT 1

                FROM promotion_tasks existing_pt

                WHERE
                  existing_pt.promotion_id = $2

                  AND existing_pt.worker_user_id = u.id
              )

            ORDER BY
              u.created_at ASC

            LIMIT $3

            FOR UPDATE OF u
            `,
            [
              promotion.user_id,
              promotion.id,
              workersLimit
            ]
          );


        for (
          const worker
          of workersResult.rows
        ) {
          if (
            assigned >= limit
          ) {
            break;
          }

          const insertResult =
            await client.query(
              `
              INSERT INTO promotion_tasks (

                promotion_id,

                worker_user_id,

                status

              )

              VALUES (

                $1,

                $2,

                'pending'

              )

              ON CONFLICT (
                promotion_id,
                worker_user_id
              )

              DO NOTHING

              RETURNING id
              `,
              [
                promotion.id,
                worker.id
              ]
            );

          if (
            insertResult.rows.length > 0
          ) {
            assigned++;
          }
        }
      }


      await client.query("COMMIT");


      return res.json({

        success: true,

        message:
          "Promotion tasks assigned",

        assigned_tasks:
          assigned
      });

    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Assign tasks error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not assign tasks"
      });

    } finally {
      client.release();
    }
  }
);


/* =========================================================
   4. MY TASKS
========================================================= */

router.get(
  "/task-queue/my-tasks",
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message:
            "Not logged in"
        });
      }

      const result =
        await query(
          `
          SELECT

            pt.id AS task_id,

            pt.status,

            pt.created_at,

            pt.completed_at,

            p.id AS promotion_id,

            p.tiktok_username,

            p.tiktok_url,

            p.promotion_type,

            p.completed_count,

            p.target_count

          FROM promotion_tasks pt

          INNER JOIN promotions p
            ON p.id = pt.promotion_id

          WHERE
            pt.worker_user_id = $1

          ORDER BY
            pt.created_at DESC

          LIMIT 100
          `,
          [user.id]
        );

      return res.json({
        success: true,
        tasks:
          result.rows
      });

    } catch (error) {

      console.error(
        "Get my tasks error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not get tasks"
      });
    }
  }
);


/* =========================================================
   5. TASK STATUS
========================================================= */

router.get(
  "/task-queue/:taskId",
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message:
            "Not logged in"
        });
      }

      const taskId =
        String(
          req.params.taskId || ""
        ).trim();

      if (!taskId) {
        return res.status(400).json({
          success: false,
          message:
            "Task ID is required"
        });
      }

      const result =
        await query(
          `
          SELECT

            pt.id AS task_id,

            pt.status,

            pt.created_at,

            pt.completed_at,

            p.id AS promotion_id,

            p.tiktok_username,

            p.tiktok_url,

            p.promotion_type,

            p.completed_count,

            p.target_count

          FROM promotion_tasks pt

          INNER JOIN promotions p
            ON p.id = pt.promotion_id

          WHERE
            pt.id = $1

            AND pt.worker_user_id = $2

          LIMIT 1
          `,
          [
            taskId,
            user.id
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Task not found"
        });
      }

      return res.json({
        success: true,
        task:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        "Get task status error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not get task status"
      });
    }
  }
);


/* =========================================================
   EXPORT
========================================================= */

module.exports = router;
