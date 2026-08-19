const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

const TIKTOK_AUTH_URL =
  "https://www.tiktok.com/v2/auth/authorize/";

const TIKTOK_TOKEN_URL =
  "https://open.tiktokapis.com/v2/oauth/token/";

const TIKTOK_USER_URL =
  "https://open.tiktokapis.com/v2/user/info/";


/* ==========================================
   HELPERS
========================================== */

function createState() {
  const timestamp = Date.now().toString();
  const random = crypto.randomBytes(32).toString("hex");

  const data = `${timestamp}.${random}`;

  const signature = crypto
    .createHmac(
      "sha256",
      process.env.TIKTOK_CLIENT_SECRET
    )
    .update(data)
    .digest("hex");

  return `${data}.${signature}`;
}


function verifyState(state) {
  try {
    const parts = state.split(".");

    if (parts.length !== 3) {
      return false;
    }

    const [timestamp, random, signature] = parts;

    const age = Date.now() - Number(timestamp);

    // State ya wuce minti 10
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > 10 * 60 * 1000
    ) {
      return false;
    }

    const data = `${timestamp}.${random}`;

    const expected = crypto
      .createHmac(
        "sha256",
        process.env.TIKTOK_CLIENT_SECRET
      )
      .update(data)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );

  } catch (error) {
    console.error("State verification error:", error);
    return false;
  }
}


function createSessionToken() {
  return crypto.randomBytes(48).toString("hex");
}


function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}


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


function setCookie(res, name, value, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`
  );
}


function clearCookie(res, name) {
  setCookie(res, name, "", 0);
}


/* ==========================================
   1. TIKTOK LOGIN
========================================== */

router.get("/tiktok/login", (req, res) => {

  try {

    const clientKey =
      process.env.TIKTOK_CLIENT_KEY;

    const redirectUri =
      process.env.TIKTOK_REDIRECT_URI;

    const clientSecret =
      process.env.TIKTOK_CLIENT_SECRET;


    if (
      !clientKey ||
      !clientSecret ||
      !redirectUri
    ) {
      return res.status(500).json({
        success: false,
        message:
          "TikTok environment variables are missing"
      });
    }


    const state = createState();


    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: "code",
      scope: "user.info.basic",
      redirect_uri: redirectUri,
      state
    });


    return res.redirect(
      `${TIKTOK_AUTH_URL}?${params.toString()}`
    );


  } catch (error) {

    console.error(
      "TikTok login error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Could not start TikTok login"
    });
  }
});


/* ==========================================
   2. TIKTOK CALLBACK
========================================== */

router.get(
  "/tiktok/callback",
  async (req, res) => {

    const client = await pool.connect();

    try {

      const {
        code,
        state,
        error,
        error_description
      } = req.query;


      /* TikTok error */

      if (error) {

        return res.status(400).json({
          success: false,
          message:
            error_description || error
        });
      }


      /* Missing data */

      if (!code || !state) {

        return res.status(400).json({
          success: false,
          message:
            "Missing TikTok code or state"
        });
      }


      /* Verify state */

      if (!verifyState(state)) {

        return res.status(403).json({
          success: false,
          message: "Invalid or expired OAuth state"
        });
      }


      /* ======================================
         EXCHANGE CODE FOR ACCESS TOKEN
      ====================================== */

      const tokenResponse =
        await fetch(
          TIKTOK_TOKEN_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",
              "Cache-Control":
                "no-cache"
            },

            body:
              new URLSearchParams({

                client_key:
                  process.env.TIKTOK_CLIENT_KEY,

                client_secret:
                  process.env.TIKTOK_CLIENT_SECRET,

                code,

                grant_type:
                  "authorization_code"

              })
          }
        );


      const tokenData =
        await tokenResponse.json();


      if (
        !tokenResponse.ok ||
        !tokenData.access_token
      ) {

        console.error(
          "TikTok token error:",
          tokenData
        );

        return res.status(400).json({
          success: false,
          message:
            "Could not get TikTok access token"
        });
      }


      /* ======================================
         GET TIKTOK USER
      ====================================== */

      const profileResponse =
        await fetch(
          `${TIKTOK_USER_URL}?fields=open_id,union_id,display_name,avatar_url`,
          {
            headers: {
              Authorization:
                `Bearer ${tokenData.access_token}`
            }
          }
        );


      const profileData =
        await profileResponse.json();


      if (
        !profileResponse.ok ||
        !profileData.data?.user
      ) {

        console.error(
          "TikTok profile error:",
          profileData
        );

        return res.status(400).json({
          success: false,
          message:
            "Could not get TikTok profile"
        });
      }


      const tiktokUser =
        profileData.data.user;


      /* ======================================
         DATABASE TRANSACTION
      ====================================== */

      await client.query("BEGIN");


      /* ======================================
         FIND USER
      ====================================== */

      const existingUserResult =
        await client.query(
          `
          SELECT *
          FROM users
          WHERE tiktok_open_id = $1
          FOR UPDATE
          `,
          [tiktokUser.open_id]
        );


      let user;
      let isNewUser = false;


      /* ======================================
         NEW USER
      ====================================== */

      if (
        existingUserResult.rows.length === 0
      ) {

        isNewUser = true;


        const newUserResult =
          await client.query(
            `
            INSERT INTO users (
              tiktok_open_id,
              tiktok_union_id,
              display_name,
              avatar_url,
              access_token,
              refresh_token,
              access_token_expires_at,
              refresh_token_expires_at,
              coins
            )

            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,

              CASE
                WHEN $7::INTEGER IS NOT NULL
                THEN NOW() +
                  ($7::INTEGER * INTERVAL '1 second')
                ELSE NULL
              END,

              CASE
                WHEN $8::INTEGER IS NOT NULL
                THEN NOW() +
                  ($8::INTEGER * INTERVAL '1 second')
                ELSE NULL
              END,

              30
            )

            RETURNING *
            `,
            [

              tiktokUser.open_id,

              tiktokUser.union_id || null,

              tiktokUser.display_name || null,

              tiktokUser.avatar_url || null,

              tokenData.access_token,

              tokenData.refresh_token || null,

              tokenData.expires_in || null,

              tokenData.refresh_expires_in || null

            ]
          );


        user =
          newUserResult.rows[0];


        /* Welcome bonus */

        await client.query(
          `
          INSERT INTO welcome_bonuses (
            user_id,
            coins_awarded
          )
          VALUES ($1, 30)
          `,
          [user.id]
        );


        /* Coin transaction */

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
            'welcome_bonus',
            30,
            0,
            30,
            'welcome_bonus',
            NULL,
            '30 coin welcome bonus'
          )
          `,
          [user.id]
        );


      } else {

        /* ====================================
           EXISTING USER
        ==================================== */

        user =
          existingUserResult.rows[0];


        const updatedUserResult =
          await client.query(
            `
            UPDATE users

            SET
              tiktok_union_id = $2,

              display_name = $3,

              avatar_url = $4,

              access_token = $5,

              refresh_token =
                COALESCE($6, refresh_token),

              access_token_expires_at =
                CASE
                  WHEN $7::INTEGER IS NOT NULL
                  THEN NOW() +
                    ($7::INTEGER * INTERVAL '1 second')
                  ELSE access_token_expires_at
                END,

              refresh_token_expires_at =
                CASE
                  WHEN $8::INTEGER IS NOT NULL
                  THEN NOW() +
                    ($8::INTEGER * INTERVAL '1 second')
                  ELSE refresh_token_expires_at
                END,

              updated_at = NOW()

            WHERE id = $1

            RETURNING *
            `,
            [

              user.id,

              tiktokUser.union_id || null,

              tiktokUser.display_name || null,

              tiktokUser.avatar_url || null,

              tokenData.access_token,

              tokenData.refresh_token || null,

              tokenData.expires_in || null,

              tokenData.refresh_expires_in || null

            ]
          );


        user =
          updatedUserResult.rows[0];
      }


      /* ======================================
         TIKTOK ACCOUNT
      ====================================== */

      await client.query(
        `
        INSERT INTO tiktok_accounts (
          user_id,
          open_id,
          display_name,
          avatar_url,
          is_verified
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          TRUE
        )

        ON CONFLICT (open_id)

        DO UPDATE SET

          display_name =
            EXCLUDED.display_name,

          avatar_url =
            EXCLUDED.avatar_url,

          updated_at =
            NOW()
        `,
        [

          user.id,

          tiktokUser.open_id,

          tiktokUser.display_name || null,

          tiktokUser.avatar_url || null

        ]
      );


      /* ======================================
         CREATE SESSION
      ====================================== */

      const sessionToken =
        createSessionToken();


      const sessionTokenHash =
        hashToken(sessionToken);


      await client.query(
        `
        INSERT INTO sessions (
          user_id,
          session_token_hash,
          expires_at
        )

        VALUES (
          $1,
          $2,
          NOW() + INTERVAL '30 days'
        )
        `,
        [
          user.id,
          sessionTokenHash
        ]
      );


      /* ======================================
         COMMIT
      ====================================== */

      await client.query("COMMIT");


      /* ======================================
         SESSION COOKIE
      ====================================== */

      setCookie(
        res,
        "session_token",
        sessionToken,
        60 * 60 * 24 * 30
      );


      /* ======================================
         SUCCESS
      ====================================== */

      return res.json({

        success: true,

        message:
          isNewUser
            ? "Welcome to FreeFollowersTik"
            : "TikTok login successful",

        new_user:
          isNewUser,

        welcome_bonus:
          isNewUser ? 30 : 0,

        user: {

          id:
            user.id,

          display_name:
            user.display_name,

          avatar_url:
            user.avatar_url,

          coins:
            user.coins

        }

      });


    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "TikTok authentication error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "TikTok authentication failed",

        error:
          process.env.NODE_ENV === "production"
            ? undefined
            : error.message

      });

    } finally {

      client.release();

    }
  }
);


/* ==========================================
   3. CURRENT USER
========================================== */

router.get("/me", async (req, res) => {

  try {

    const cookies =
      parseCookies(
        req.headers.cookie || ""
      );


    const sessionToken =
      cookies.session_token;


    if (!sessionToken) {

      return res.status(401).json({
        success: false,
        message: "Not logged in"
      });
    }


    const sessionHash =
      hashToken(sessionToken);


    const result =
      await query(
        `
        SELECT

          u.id,

          u.tiktok_open_id,

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

      clearCookie(
        res,
        "session_token"
      );

      return res.status(401).json({
        success: false,
        message: "Session expired"
      });
    }


    const user =
      result.rows[0];


    if (
      !user.is_active ||
      user.is_banned
    ) {

      clearCookie(
        res,
        "session_token"
      );

      return res.status(403).json({
        success: false,
        message:
          "Account is not active"
      });
    }


    return res.json({
      success: true,
      user
    });


  } catch (error) {

    console.error(
      "Get current user error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Could not get user"
    });
  }
});


/* ==========================================
   4. LOGOUT
========================================== */

router.post("/logout", async (req, res) => {

  try {

    const cookies =
      parseCookies(
        req.headers.cookie || ""
      );


    const sessionToken =
      cookies.session_token;


    if (sessionToken) {

      const sessionHash =
        hashToken(sessionToken);


      await query(
        `
        DELETE FROM sessions
        WHERE session_token_hash = $1
        `,
        [sessionHash]
      );
    }


    clearCookie(
      res,
      "session_token"
    );


    return res.json({

      success: true,

      message:
        "Logged out successfully"

    });


  } catch (error) {

    console.error(
      "Logout error:",
      error
    );

    return res.status(500).json({

      success: false,

      message:
        "Logout failed"

    });
  }
});


module.exports = router;
