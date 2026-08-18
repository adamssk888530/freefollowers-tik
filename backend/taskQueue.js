const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const MAX_TASKS_PER_REQUEST = 20;
const TASK_REWARD_COINS = 5;


/* ==========================================
   HELPERS
========================================== */

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


/* ==========================================
   1. GET NEXT TASK
========================================== */

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


      /*
        Get the oldest pending task
        belonging to this worker.
      */

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

        await client.query(
          "ROLLBACK"
        );

        return res.json({
          success: true,
          has_task: false,
          message: "No task available"
        });
      }


      const task =
        result.rows[0];


      await client.query(
        "COMMIT"
      );


      return res.json({
        success: true,

        has_task: true,

        task: {
          id: task.task_id,

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
              task.completed_count,

            target:
              task.target_count
          }
        }
      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
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


/* ==========================================
   2. VERIFY / COMPLETE TASK
========================================== */

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
          message: "Not logged in"
        });
      }


      const taskId =
        String(
          req.body.task_id || ""
        ).trim();


      if (!taskId) {
        return res.status(400).json({
          success: false,
          message:
            "Task ID is required"
        });
      }


      await client.query("BEGIN");


      /*
        Lock the task.

        This prevents two requests
        from rewarding the same task.
      */

      const taskResult =
        await client.query(
          `
          SELECT
            pt.id AS task_id,

            pt.worker_user_id,

            pt.status,

            p.id AS promotion_id,

            p.user_id AS promotion_owner_id,

            p.status AS promotion_status,

            p.completed_count,

            p.target_count

          FROM promotion_tasks pt

          INNER JOIN promotions p
            ON p.id = pt.promotion_id

          WHERE
            pt.id = $1

            AND pt.worker_user_id = $2

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

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          success: false,
          message: "Task not found"
        });
      }


      const task =
        taskResult.rows[0];


      /*
        Never reward a completed task twice.
      */

      if (
        task.status !== "pending"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          success: false,
          message:
            "This task has already been completed"
        });
      }


      /*
        Make sure the promotion
        is still active.
      */

      if (
        task.promotion_status !==
        "pending"
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          success: false,
          message:
            "This promotion is no longer active"
        });
      }


      /*
        Make sure target has not
        already been reached.
      */

      if (
        Number(task.completed_count) >=
        Number(task.target_count)
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          success: false,
          message:
            "This promotion is already complete"
        });
      }


      /*
        IMPORTANT

        At this stage the server is
        completing the assigned task.

        Actual TikTok follow verification
        must be added separately when the
        required TikTok API capability/
        permission is available.

        We do NOT trust a client-sent
        "verified = true" value.
      */


      /* ==========================================
         LOCK USER
      ========================================== */

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

        await client.query(
          "ROLLBACK"
        );

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


      const balanceAfter =
        balanceBefore +
        TASK_REWARD_COINS;


      /* ==========================================
         MARK TASK COMPLETE
      ========================================== */

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
            taskId,
            user.id
          ]
        );


      /*
        If another request completed it
        first, do not reward again.
      */

      if (
        completedTaskResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({
          success: false,
          message:
            "This task has already been completed"
        });
      }


      /* ==========================================
         UPDATE PROMOTION COUNT
      ========================================== */

      const promotionUpdate =
        await client.query(
          `
          UPDATE promotions

          SET
            completed_count =
              completed_count + 1,

            status =
              CASE
                WHEN completed_count + 1
                     >= target_count
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
          [
            task.promotion_id
          ]
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


      /* ==========================================
         ADD COINS
      ========================================== */

      const walletResult =
        await client.query(
          `
          UPDATE users

          SET
            coins = coins + $2,
            updated_at = NOW()

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


      /* ==========================================
         COIN TRANSACTION
      ========================================== */

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

          task.task_id,

          "Reward for completing TikTok promotion task"
        ]
      );


      /* ==========================================
         COMMIT
      ========================================== */

      await client.query(
        "COMMIT"
      );


      return res.json({
        success: true,

        message:
          "Task completed successfully. +5 coins added.",

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
        await client.query(
          "ROLLBACK"
        );
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


/* ==========================================
   3. ASSIGN TASKS
   ADMIN / SYSTEM
========================================== */

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
          message: "Not logged in"
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
          req.body.limit ||
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


      await client.query(
        "BEGIN"
      );


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
              Math.min(
                remaining,
                limit - assigned
              )
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


      await client.query(
        "COMMIT"
      );


      return res.json({
        success: true,

        message:
          "Promotion tasks assigned",

        assigned_tasks:
          assigned
      });

    } catch (error) {

      try {
        await client.query(
          "ROLLBACK"
        );
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


/* ==========================================
   4. MY TASKS
========================================== */

router.get(
  "/task-queue/my-tasks",
  async (req, res) => {

    try {

      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Not logged in"
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


/* ==========================================
   5. TASK STATUS
========================================== */

router.get(
  "/task-queue/:taskId",
  async (req, res) => {

    try {

      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Not logged in"
        });
      }


      const {
        taskId
      } = req.params;


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


module.exports = router;
