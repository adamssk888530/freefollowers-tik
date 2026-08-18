const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const MAX_TASKS_PER_REQUEST = 20;


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

    cookies[key] = decodeURIComponent(value);
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
   1. GET NEXT AVAILABLE PROMOTION TASK
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
        Find a pending promotion task that:

        1. Belongs to this worker.
        2. Has not been completed.
        3. Promotion is still active.
      */

      const taskResult =
        await client.query(
          `
          SELECT
            pt.id AS task_id,

            p.id AS promotion_id,

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


      if (
        taskResult.rows.length === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.json({
          success: true,

          has_task: false,

          message:
            "No task available"
        });
      }


      const task =
        taskResult.rows[0];


      await client.query(
        "COMMIT"
      );


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

          reward_coins: 5,

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
        "Get task queue error:",
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
   2. ASSIGN TASKS TO USERS
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


      /*
        Find active promotions
        that still need workers.
      */

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

          ORDER BY created_at ASC

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
          promotion.target_count -
          promotion.completed_count;


        if (
          remaining <= 0
        ) {
          continue;
        }


        /*
          Find eligible workers.

          Exclude:
          - Promotion owner
          - Users who already have this promotion
          - Banned/inactive users
        */

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
                  existing_pt.promotion_id =
                    $2

                  AND existing_pt.worker_user_id =
                    u.id
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


          /*
            Insert one task
            for one worker.
          */

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
   3. MY TASKS
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
   4. TASK STATUS
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
