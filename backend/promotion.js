const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const MIN_PROMOTION_COINS = 60;
const COINS_PER_FOLLOWER = 10;
const MAX_PROMOTION_COINS = 100000;


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
   CURRENT USER
========================================== */

async function getCurrentUser(req) {

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

  if (
    result.rows.length === 0
  ) {
    return null;
  }

  const user =
    result.rows[0];

  if (
    !user.is_active ||
    user.is_banned
  ) {
    return null;
  }

  return user;
}


/* ==========================================
   GET CONNECTED TIKTOK ACCOUNT
========================================== */

async function getTikTokAccount(userId) {

  const result =
    await query(
      `
      SELECT
        id,
        user_id,
        open_id,
        username,
        profile_deep_link,
        display_name,
        avatar_url,
        is_verified

      FROM tiktok_accounts

      WHERE user_id = $1

      ORDER BY created_at DESC

      LIMIT 1
      `,
      [userId]
    );

  if (
    result.rows.length === 0
  ) {
    return null;
  }

  return result.rows[0];
}


/* ==========================================
   VALIDATE TIKTOK URL
========================================== */

function isValidTikTokUrl(value) {

  try {

    const url =
      new URL(value);

    if (
      url.protocol !== "https:"
    ) {
      return false;
    }

    const hostname =
      url.hostname.toLowerCase();

    return (
      hostname === "tiktok.com" ||
      hostname === "www.tiktok.com" ||
      hostname.endsWith(".tiktok.com")
    );

  } catch {

    return false;

  }
}


/* ==========================================
   NORMALIZE USERNAME
========================================== */

function normalizeUsername(value) {

  let username =
    String(value || "")
      .trim();

  if (
    username.startsWith("@")
  ) {
    username =
      username.slice(1);
  }

  return username;

}


/* ==========================================
   VALIDATE PROMOTION COINS
========================================== */

function validatePromotionCoins(value) {

  const coins =
    Number(value);

  if (
    !Number.isInteger(coins)
  ) {

    return {
      valid: false,
      message:
        "Coin amount must be a whole number"
    };

  }

  if (
    coins < MIN_PROMOTION_COINS
  ) {

    return {
      valid: false,
      message:
        "Minimum promotion is 60 coins"
    };

  }

  if (
    coins > MAX_PROMOTION_COINS
  ) {

    return {
      valid: false,
      message:
        "Promotion amount is too high"
    };

  }

  if (
    coins % COINS_PER_FOLLOWER !== 0
  ) {

    return {
      valid: false,
      message:
        "Coins must be a multiple of 10"
    };

  }

  return {
    valid: true,
    coins
  };

}


/* ==========================================
   1. PROMOTION PREVIEW
========================================== */

router.post(
  "/promotions/preview",
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


      const validation =
        validatePromotionCoins(
          req.body.coins
        );


      if (!validation.valid) {

        return res.status(400).json({

          success: false,

          message:
            validation.message,

          minimum_coins:
            MIN_PROMOTION_COINS,

          coins_per_follower:
            COINS_PER_FOLLOWER

        });

      }


      const coins =
        validation.coins;


      if (
        coins > Number(user.coins)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Insufficient coins",

          balance:
            Number(user.coins),

          required:
            coins,

          missing:
            coins -
            Number(user.coins)

        });

      }


      const followers =
        coins /
        COINS_PER_FOLLOWER;


      return res.json({

        success: true,

        promotion: {

          coins,

          followers,

          minimum_coins:
            MIN_PROMOTION_COINS,

          coins_per_follower:
            COINS_PER_FOLLOWER

        },

        wallet: {

          current_balance:
            Number(user.coins),

          balance_after:
            Number(user.coins) -
            coins

        }

      });

    } catch (error) {

      console.error(
        "Promotion preview error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not calculate promotion"

      });

    }

  }
);


/* ==========================================
   2. CREATE PROMOTION
========================================== */

router.post(
  "/promotions",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      /* ======================================
         AUTHENTICATED USER
      ====================================== */

      const user =
        await getCurrentUser(req);


      if (!user) {

        return res.status(401).json({

          success: false,

          message:
            "Not logged in"

        });

      }


      /* ======================================
         COIN VALIDATION
      ====================================== */

      const validation =
        validatePromotionCoins(
          req.body.coins
        );


      if (!validation.valid) {

        return res.status(400).json({

          success: false,

          message:
            validation.message,

          minimum_coins:
            MIN_PROMOTION_COINS,

          coins_per_follower:
            COINS_PER_FOLLOWER

        });

      }


      const promotionCoins =
        validation.coins;


      const targetFollowers =
        promotionCoins /
        COINS_PER_FOLLOWER;


      /* ======================================
         GET CONNECTED TIKTOK ACCOUNT

         IMPORTANT:
         Frontend ba ya aika username/url.

         Backend yana dauko account daga
         tiktok_accounts ta user_id.
      ====================================== */

      const tiktokAccount =
        await getTikTokAccount(
          user.id
        );


      if (!tiktokAccount) {

        return res.status(400).json({

          success: false,

          message:
            "No TikTok account is connected to your account. Please connect your TikTok account first."

        });

      }


      const username =
        normalizeUsername(
          tiktokAccount.username
        );


      if (
        !username ||
        username.length < 1 ||
        username.length > 100
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Your connected TikTok account does not have a valid username."

        });

      }


      if (
        !/^[A-Za-z0-9._]+$/.test(
          username
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Your connected TikTok username is invalid."

        });

      }


      /* ======================================
         CREATE TIKTOK URL
      ====================================== */

      const tiktokUrl =
        `https://www.tiktok.com/@${username}`;


      if (
        !isValidTikTokUrl(
          tiktokUrl
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Could not create a valid TikTok URL."

        });

      }


      /* ======================================
         START TRANSACTION
      ====================================== */

      await client.query(
        "BEGIN"
      );


      /* ======================================
         LOCK USER
      ====================================== */

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
          [user.id]
        );


      if (
        userResult.rows.length === 0
      ) {

        throw new Error(
          "User not found"
        );

      }


      const currentUser =
        userResult.rows[0];


      if (
        !currentUser.is_active ||
        currentUser.is_banned
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


      /* ======================================
         FINAL BALANCE CHECK
      ====================================== */

      const currentBalance =
        Number(
          currentUser.coins || 0
        );


      if (
        currentBalance <
        promotionCoins
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          success: false,

          message:
            "Insufficient coins",

          balance:
            currentBalance,

          required:
            promotionCoins,

          missing:
            promotionCoins -
            currentBalance

        });

      }


      const balanceBefore =
        currentBalance;


      const balanceAfter =
        balanceBefore -
        promotionCoins;


      /* ======================================
         DEDUCT COINS
      ====================================== */

      const walletResult =
        await client.query(
          `
          UPDATE users

          SET
            coins = $1,
            updated_at = NOW()

          WHERE id = $2

          RETURNING
            id,
            coins
          `,
          [
            balanceAfter,
            user.id
          ]
        );


      if (
        walletResult.rows.length === 0
      ) {

        throw new Error(
          "Could not update wallet"
        );

      }


      /* ======================================
         CREATE PROMOTION
      ====================================== */

      const promotionResult =
        await client.query(
          `
          INSERT INTO promotions (
            user_id,
            tiktok_username,
            tiktok_url,
            promotion_type,
            coins_cost,
            target_count,
            completed_count,
            status
          )

          VALUES (
            $1,
            $2,
            $3,
            'followers',
            $4,
            $5,
            0,
            'pending'
          )

          RETURNING *
          `,
          [
            user.id,
            username,
            tiktokUrl,
            promotionCoins,
            targetFollowers
          ]
        );


      if (
        promotionResult.rows.length === 0
      ) {

        throw new Error(
          "Could not create promotion"
        );

      }


      const promotion =
        promotionResult.rows[0];


      /* ======================================
         COIN TRANSACTION
      ====================================== */

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
          'promotion_purchase',
          $2,
          $3,
          $4,
          'promotion',
          $5,
          $6
        )
        `,
        [
          user.id,

          -promotionCoins,

          balanceBefore,

          balanceAfter,

          String(
            promotion.id
          ),

          `${promotionCoins} coins used for ${targetFollowers} follower promotion`
        ]
      );


      /* ======================================
         INITIAL TASK ASSIGNMENT
      ====================================== */

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

              FROM promotion_tasks pt

              WHERE
                pt.promotion_id = $2

                AND pt.worker_user_id = u.id
            )

          ORDER BY
            u.created_at ASC

          LIMIT $3

          FOR UPDATE OF u
          `,
          [
            user.id,

            promotion.id,

            targetFollowers
          ]
        );


      let assignedTasks = 0;


      for (
        const worker
        of workersResult.rows
      ) {

        const taskResult =
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
          taskResult.rows.length > 0
        ) {

          assignedTasks++;

        }

      }


      /* ======================================
         COMMIT
      ====================================== */

      await client.query(
        "COMMIT"
      );


      /* ======================================
         SUCCESS
      ====================================== */

      return res.status(201).json({

        success: true,

        message:
          "Promotion created successfully",

        promotion: {

          id:
            promotion.id,

          tiktok_username:
            promotion.tiktok_username,

          tiktok_url:
            promotion.tiktok_url,

          coins:
            promotionCoins,

          followers:
            targetFollowers,

          completed:
            0,

          remaining:
            targetFollowers,

          assigned_tasks:
            assignedTasks,

          status:
            "pending"

        },

        wallet: {

          previous_balance:
            balanceBefore,

          spent:
            promotionCoins,

          new_balance:
            balanceAfter

        },

        coins:
          balanceAfter

      });

    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch {}


      console.error(
        "Create promotion error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Could not create promotion"

      });

    } finally {

      client.release();

    }

  }
);


/* ==========================================
   3. MY PROMOTIONS
========================================== */

router.get(
  "/promotions",
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

          WHERE user_id = $1

          ORDER BY created_at DESC

          LIMIT 100
          `,
          [user.id]
        );


      return res.json({

        success: true,

        promotions:
          result.rows

      });

    } catch (error) {

      console.error(
        "Get promotions error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Could not get promotions"

      });

    }

  }
);


/* ==========================================
   4. PROMOTION DETAILS
========================================== */

router.get(
  "/promotions/:promotionId",
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


      const {
        promotionId
      } = req.params;


      const result =
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
            id = $1
            AND user_id = $2

          LIMIT 1
          `,
          [
            promotionId,
            user.id
          ]
        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            "Promotion not found"

        });

      }


      const promotion =
        result.rows[0];


      return res.json({

        success: true,

        promotion: {

          ...promotion,

          remaining:
            Math.max(
              0,
              Number(
                promotion.target_count
              ) -
              Number(
                promotion.completed_count
              )
            )

        }

      });

    } catch (error) {

      console.error(
        "Get promotion details error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "Could not get promotion"

      });

    }

  }
);


module.exports = router;
