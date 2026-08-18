const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const PROMOTION_COST = 60;
const PROMOTION_TARGET = 6;


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

    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
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
   1. CREATE PROMOTION
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
        tiktok_url
      } = req.body;


      /* ------------------------------------------
         VALIDATE INPUT
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


      await client.query("BEGIN");


      /* ------------------------------------------
         LOCK USER BALANCE
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


      if (userResult.rows.length === 0) {
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
         BALANCE VALIDATION
      ------------------------------------------ */

      if (
        currentUser.coins <
        PROMOTION_COST
      ) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          success: false,
          message:
            "Insufficient coins",
          required:
            PROMOTION_COST,
          balance:
            currentUser.coins
        });
      }


      const balanceBefore =
        currentUser.coins;

      const balanceAfter =
        balanceBefore -
        PROMOTION_COST;


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

            tiktok_username
              .trim(),

            tiktok_url
              .trim(),

            PROMOTION_COST,

            PROMOTION_TARGET
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

          -PROMOTION_COST,

          balanceBefore,

          balanceAfter,

          promotion.id,

          '60 coins used for 6 follower promotion'
        ]
      );


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

          followers:
            PROMOTION_TARGET,

          coins_cost:
            PROMOTION_COST,

          completed:
            0,

          status:
            promotion.status
        },

        wallet: {
          previous_balance:
            balanceBefore,

          spent:
            PROMOTION_COST,

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
   2. MY PROMOTIONS
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
   3. PROMOTION DETAILS
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


      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message:
            "Promotion not found"
        });
      }


      return res.json({
        success: true,
        promotion:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        "Get promotion error:",
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
