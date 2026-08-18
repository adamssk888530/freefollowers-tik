const express = require("express");
const crypto = require("crypto");
const { query } = require("./db");

const router = express.Router();

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


/* ==========================================
   CURRENT USER
========================================== */

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

  if (!user.is_active || user.is_banned) {
    return null;
  }

  return user;
}


/* ==========================================
   1. GET NEXT EARN TASK
========================================== */

router.get("/earn/next", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Not logged in"
      });
    }

    /*
      Find the next pending task assigned
      to this user.

      The user does NOT choose the task.
      The server chooses it.
    */

    const result = await query(
      `
      SELECT
        pt.id AS task_id,

        p.id AS promotion_id,
        p.tiktok_username,
        p.tiktok_url,
        p.promotion_type,

        p.coins_cost,
        p.target_count,
        p.completed_count,

        pt.status,
        pt.created_at

      FROM promotion_tasks pt

      INNER JOIN promotions p
        ON p.id = pt.promotion_id

      WHERE
        pt.worker_user_id = $1

        AND pt.status = 'pending'

        AND p.status = 'pending'

        AND p.completed_count < p.target_count

        AND p.user_id <> $1

        AND NOT EXISTS (
          SELECT 1
          FROM earn_completions ec
          WHERE
            ec.task_id = pt.promotion_id
            AND ec.user_id = $1
        )

      ORDER BY pt.created_at ASC

      LIMIT 1
      `,
      [user.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        has_task: false,
        message: "No more tasks available"
      });
    }

    const task = result.rows[0];

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

    console.error(
      "Get next earn task error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Could not get next earn task"
    });
  }
});


/* ==========================================
   2. TASK STATUS
========================================== */

router.get(
  "/earn/task/:taskId",
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

      const { taskId } =
        req.params;


      const result =
        await query(
          `
          SELECT
            pt.id AS task_id,

            pt.status,

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


      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Task not found"
        });
      }


      const task =
        result.rows[0];


      return res.json({
        success: true,

        task: {
          id: task.task_id,

          status:
            task.status,

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

      console.error(
        "Get earn task error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not get earn task"
      });
    }
  }
);


/* ==========================================
   3. COMPLETE TASK
========================================== */

/*
   IMPORTANT:

   We DO NOT award coins here yet.

   TikTok does not currently give our app,
   with user.info.basic, a direct way to
   verify that the worker followed the target.

   Therefore this endpoint is intentionally
   protected from fake client-side verification.

   Later we will replace this section with
   server-side TikTok verification.
*/

router.post(
  "/earn/task/:taskId/complete",
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


      const { taskId } =
        req.params;


      const result =
        await query(
          `
          SELECT
            pt.id,
            pt.status,

            p.id AS promotion_id,
            p.status AS promotion_status,

            p.tiktok_username,
            p.tiktok_url

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


      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Task not found"
        });
      }


      const task =
        result.rows[0];


      if (task.status !== "pending") {
        return res.status(400).json({
          success: false,
          message:
            "Task has already been processed"
        });
      }


      if (task.promotion_status !== "pending") {
        return res.status(400).json({
          success: false,
          message:
            "Promotion is no longer active"
        });
      }


      /*
        DO NOT trust:

        req.body.followed
        req.body.verified

        because users can modify those
        values from the browser.
      */

      return res.status(409).json({
        success: false,

        verification_required: true,

        message:
          "TikTok follow verification is not configured yet. No coins were awarded."
      });

    } catch (error) {

      console.error(
        "Complete earn task error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not complete earn task"
      });
    }
  }
);


module.exports = router;
