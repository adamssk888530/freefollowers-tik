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
   GET CURRENT USER ID
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
   1. GET WALLET BALANCE
========================================== */

router.get("/wallet", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Not logged in"
      });
    }

    return res.json({
      success: true,
      wallet: {
        coins: user.coins
      }
    });

  } catch (error) {
    console.error(
      "Wallet balance error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Could not get wallet balance"
    });
  }
});


/* ==========================================
   2. ADD COINS
   INTERNAL / ADMIN CONTROLLED
========================================== */

router.post("/wallet/add", async (req, res) => {
  const client = await pool.connect();

  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Not logged in"
      });
    }

    /*
      Ordinary users cannot call this endpoint
      to give themselves coins.
    */

    if (!user.is_admin) {
      return res.status(403).json({
        success: false,
        message: "Admin access required"
      });
    }

    const {
      user_id,
      amount,
      reason
    } = req.body;

    const coinsToAdd =
      Number(amount);

    if (
      !Number.isInteger(coinsToAdd) ||
      coinsToAdd <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Amount must be a positive whole number"
      });
    }

    if (coinsToAdd > 1000000) {
      return res.status(400).json({
        success: false,
        message: "Amount is too large"
      });
    }

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required"
      });
    }

    await client.query("BEGIN");


    /* Lock target user */

    const targetResult =
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
        [user_id]
      );

    if (targetResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const targetUser =
      targetResult.rows[0];

    if (
      !targetUser.is_active ||
      targetUser.is_banned
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Target user is not active"
      });
    }


    const balanceBefore =
      targetUser.coins;

    const balanceAfter =
      balanceBefore + coinsToAdd;


    /* Update balance */

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
        user_id
      ]
    );


    /* Transaction record */

    await client.query(
      `
      INSERT INTO coin_transactions (
        user_id,
        type,
        amount,
        balance_before,
        balance_after,
        reference_type,
        description
      )
      VALUES (
        $1,
        'admin_credit',
        $2,
        $3,
        $4,
        'admin',
        $5
      )
      `,
      [
        user_id,
        coinsToAdd,
        balanceBefore,
        balanceAfter,
        reason ||
          "Coins added by admin"
      ]
    );


    /* Admin audit record */

    await client.query(
      `
      INSERT INTO admin_actions (
        admin_user_id,
        action,
        target_user_id,
        details
      )
      VALUES (
        $1,
        'add_coins',
        $2,
        $3
      )
      `,
      [
        user.id,
        user_id,
        JSON.stringify({
          amount: coinsToAdd,
          reason:
            reason ||
            "Coins added by admin"
        })
      ]
    );


    await client.query("COMMIT");


    return res.json({
      success: true,
      message: "Coins added successfully",

      wallet: {
        previous_balance:
          balanceBefore,

        added:
          coinsToAdd,

        new_balance:
          balanceAfter
      }
    });

  } catch (error) {

    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error(
      "Add coins error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Could not add coins"
    });

  } finally {
    client.release();
  }
});


/* ==========================================
   3. DEDUCT COINS
   INTERNAL / ADMIN CONTROLLED
========================================== */

router.post(
  "/wallet/deduct",
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


      const {
        user_id,
        amount,
        reason
      } = req.body;

      const coinsToDeduct =
        Number(amount);


      if (
        !Number.isInteger(coinsToDeduct) ||
        coinsToDeduct <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Amount must be a positive whole number"
        });
      }


      if (!user_id) {
        return res.status(400).json({
          success: false,
          message:
            "user_id is required"
        });
      }


      await client.query("BEGIN");


      /* Lock target user */

      const targetResult =
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
          [user_id]
        );


      if (targetResult.rows.length === 0) {

        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "User not found"
        });
      }


      const targetUser =
        targetResult.rows[0];


      if (
        !targetUser.is_active ||
        targetUser.is_banned
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Target user is not active"
        });
      }


      const balanceBefore =
        targetUser.coins;


      /* Balance validation */

      if (
        balanceBefore < coinsToDeduct
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Insufficient coin balance"
        });
      }


      const balanceAfter =
        balanceBefore -
        coinsToDeduct;


      /* Update balance */

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
          user_id
        ]
      );


      /* Transaction record */

      await client.query(
        `
        INSERT INTO coin_transactions (
          user_id,
          type,
          amount,
          balance_before,
          balance_after,
          reference_type,
          description
        )
        VALUES (
          $1,
          'admin_debit',
          $2,
          $3,
          $4,
          'admin',
          $5
        )
        `,
        [
          user_id,
          -coinsToDeduct,
          balanceBefore,
          balanceAfter,
          reason ||
            "Coins deducted by admin"
        ]
      );


      /* Admin audit */

      await client.query(
        `
        INSERT INTO admin_actions (
          admin_user_id,
          action,
          target_user_id,
          details
        )
        VALUES (
          $1,
          'deduct_coins',
          $2,
          $3
        )
        `,
        [
          user.id,
          user_id,
          JSON.stringify({
            amount:
              coinsToDeduct,

            reason:
              reason ||
              "Coins deducted by admin"
          })
        ]
      );


      await client.query("COMMIT");


      return res.json({
        success: true,

        message:
          "Coins deducted successfully",

        wallet: {
          previous_balance:
            balanceBefore,

          deducted:
            coinsToDeduct,

          new_balance:
            balanceAfter
        }
      });

    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Deduct coins error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not deduct coins"
      });

    } finally {
      client.release();
    }
  }
);


/* ==========================================
   4. TRANSACTION HISTORY
========================================== */

router.get(
  "/wallet/transactions",
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
            type,
            amount,
            balance_before,
            balance_after,
            reference_type,
            reference_id,
            description,
            created_at

          FROM coin_transactions

          WHERE user_id = $1

          ORDER BY created_at DESC

          LIMIT 100
          `,
          [user.id]
        );


      return res.json({
        success: true,

        transactions:
          result.rows
      });

    } catch (error) {

      console.error(
        "Transaction history error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Could not get transaction history"
      });
    }
  }
);


module.exports = router;
