const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const MIN_PROMOTION_COINS = 60;
const COINS_PER_FOLLOWER = 10;


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
   VALIDATE TIKTOK URL
========================================== */

function isValidTikTokUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") {
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
   1. PROMOTION PRICE PREVIEW
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
          message: "Not logged in"
        });
      }


      const coins =
        Number(req.body.coins);


      if (
        !Number.isInteger(coins) ||
        coins <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid coin amount"
        });
      }


      if (
        coins < MIN_PROMOTION_COINS
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Minimum promotion is 60 coins",
          minimum_coins:
            MIN_PROMOTION_COINS
        });
      }


      if (
        coins % COINS_PER_FOLLOWER !== 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Coins must be a multiple of 10",
          example:
            "60, 70, 80, 100..."
        });
      }


      if (coins > user.coins) {
        return res.status(400).json({
          success: false,
          message:
            "Insufficient coins",
          balance:
            user.coins,
          required:
            coins,
          missing:
            coins - user.coins
        });
      }


      const followers =
        coins / COINS_PER_FOLLOWER;


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
            user.coins,

          balance_after:
            user.coins - coins
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

      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Not logged in"
        });
      }


      const {
        tiktok_username,
        tiktok_url,
        coins
      } = req.body;


      /* ------------------------------------------
         VALIDATE USERNAME
      ------------------------------------------ */

      if (
        typeof tiktok_username !== "string" ||
        tiktok_username.trim().length < 1 ||
        tiktok_username.trim().length > 100
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid TikTok username is required"
        });
      }


      /* ------------------------------------------
         VALIDATE URL
      ------------------------------------------ */

      if (
        typeof tiktok_url !== "string" ||
        !isValidTikTokUrl(
          tiktok_url.trim()
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid TikTok URL is required"
        });
      }


      /* ------------------------------------------
         VALIDATE COINS
      ------------------------------------------ */

      const promotionCoins =
        Number(coins);


      if (
        !Number.isInteger(
          promotionCoins
        ) ||
        promotionCoins <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid coin amount"
        });
      }


      if (
        promotionCoins <
        MIN_PROMOTION_COINS
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Minimum promotion is 60 coins",
          minimum_coins:
            MIN_PROMOTION_COINS
        });
      }


      if (
        promotionCoins %
          COINS_PER_FOLLOWER !==
        0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Coins must be a multiple of 10",
          example:
            "60, 70, 80, 100..."
        });
      }


      const targetFollowers =
        promotionCoins /
        COINS_PER_FOLLOWER;


      /* ------------------------------------------
         START DATABASE TRANSACTION
      ------------------------------------------ */

      await client.query("BEGIN");


      /* ------------------------------------------
         LOCK USER
      ------------------------------------------ */

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


      /* ------------------------------------------
         FINAL BALANCE CHECK
         This is done inside the transaction.
      ------------------------------------------ */

      if (
        currentUser.coins <
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
            currentUser.coins,

          required:
            promotionCoins,

          missing:
            promotionCoins -
            currentUser.coins
        });
      }


      const balanceBefore =
        currentUser.coins;

      const balanceAfter =
        balanceBefore -
        promotionCoins;


      /* ------------------------------------------
         DEDUCT COINS
      ------------------------------------------ */

      await client.query(
        `
        UPDATE users

        SET
          coins = $1,
          updated_at = NOW()

        WHERE id = $2
        `,
        [
          balanceAfter,
          user.id
        ]
      );


      /* ------------------------------------------
         CREATE PROMOTION
      ------------------------------------------ */

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

            tiktok_username.trim(),

            tiktok_url.trim(),

            promotionCoins,

            targetFollowers
          ]
        );


      const promotion =
        promotionResult.rows[0];


      /* ------------------------------------------
         COIN TRANSACTION
      ------------------------------------------ */

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

          promotion.id,

          `${promotionCoins} coins used for ${targetFollowers} follower promotion`
        ]
      );


      /* ------------------------------------------
         COMMIT
      ------------------------------------------ */

      await client.query(
        "COMMIT"
      );


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
        }
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
          message: "Not logged in"
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
          message: "Not logged in"
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
              promotion.target_count -
                promotion.completed_count
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
