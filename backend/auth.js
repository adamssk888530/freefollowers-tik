const express = require("express");
const crypto = require("crypto");
const { query, pool } = require("./db");

const router = express.Router();

/* ==========================================
   TIKTOK CONFIG
========================================== */

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

  const random =
    crypto.randomBytes(32).toString("hex");

  const data =
    `${timestamp}.${random}`;

  const secret =
    process.env.TIKTOK_CLIENT_SECRET;

  if (!secret) {
    throw new Error(
      "TIKTOK_CLIENT_SECRET is missing"
    );
  }

  const signature =
    crypto
      .createHmac("sha256", secret)
      .update(data)
      .digest("hex");

  return `${data}.${signature}`;
}


function verifyState(state) {
  try {

    if (!state) {
      return false;
    }

    const parts =
      state.split(".");

    if (parts.length !== 3) {
      return false;
    }

    const [
      timestamp,
      random,
      signature
    ] = parts;

    const age =
      Date.now() - Number(timestamp);

    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > 10 * 60 * 1000
    ) {
      return false;
    }

    const data =
      `${timestamp}.${random}`;

    const secret =
      process.env.TIKTOK_CLIENT_SECRET;

    if (!secret) {
      return false;
    }

    const expected =
      crypto
        .createHmac("sha256", secret)
        .update(data)
        .digest("hex");

    const signatureBuffer =
      Buffer.from(signature, "hex");

    const expectedBuffer =
      Buffer.from(expected, "hex");

    if (
      signatureBuffer.length !==
      expectedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      signatureBuffer,
      expectedBuffer
    );

  } catch (error) {

    console.error(
      "State verification error:",
      error
    );

    return false;
  }
}


function createSessionToken() {
  return crypto
    .randomBytes(48)
    .toString("hex");
}


function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}


function parseCookies(cookieHeader = "") {

  const cookies = {};

  cookieHeader
    .split(";")
    .forEach((item) => {

      const index =
        item.indexOf("=");

      if (index === -1) {
        return;
      }

      const key =
        item.slice(0, index).trim();

      const value =
        item.slice(index + 1).trim();

      try {

        cookies[key] =
          decodeURIComponent(value);

      } catch {

        cookies[key] =
          value;
      }

    });

  return cookies;
}


/* ==========================================
   COOKIE
========================================== */

function setCookie(
  res,
  name,
  value,
  maxAge
) {

  res.setHeader(
    "Set-Cookie",
    [
      `${name}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${maxAge}`
    ].join("; ")
  );
}


function clearCookie(
  res,
  name
) {

  setCookie(
    res,
    name,
    "",
    0
  );
}


/* ==========================================
   ENVIRONMENT CHECK
========================================== */

function checkTikTokEnvironment() {

  const required = [
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "TIKTOK_REDIRECT_URI"
  ];

  const missing =
    required.filter(
      (key) => !process.env[key]
    );

  return {
    valid:
      missing.length === 0,

    missing
  };
}


/* ==========================================
   1. TIKTOK LOGIN
========================================== */

router.get(
  "/tiktok/login",
  (req, res) => {

    try {

      const environment =
        checkTikTokEnvironment();

      if (!environment.valid) {

        return res.status(500).json({

          success: false,

          message:
            "TikTok environment variables are missing",

          missing:
            environment.missing

        });
      }


      const clientKey =
        process.env.TIKTOK_CLIENT_KEY;

      const redirectUri =
        process.env.TIKTOK_REDIRECT_URI;


      if (
        !redirectUri ||
        !redirectUri.startsWith("https://")
      ) {

        return res.status(500).json({

          success: false,

          message:
            "TIKTOK_REDIRECT_URI must use HTTPS",

          redirect_uri:
            redirectUri || null

        });
      }


      const state =
        createState();


      const params =
        new URLSearchParams();


      params.set(
        "client_key",
        clientKey
      );


      params.set(
        "response_type",
        "code"
      );


      /*
       * IMPORTANT:
       *
       * user.info.profile is required
       * for username, profile_deep_link
       * and is_verified.
       */

      params.set(
        "scope",
        "user.info.basic,user.info.profile"
      );


      params.set(
        "redirect_uri",
        redirectUri
      );


      params.set(
        "state",
        state
      );


      const authorizationUrl =
        `${TIKTOK_AUTH_URL}?${params.toString()}`;


      console.log(
        "TikTok authorization started"
      );

      console.log(
        "Requested scopes:",
        "user.info.basic,user.info.profile"
      );

      console.log(
        "Redirect URI:",
        redirectUri
      );


      return res.redirect(
        authorizationUrl
      );


    } catch (error) {

      console.error(
        "TikTok login error:",
        error
      );

      return res.status(500).json({

        success: false,

        message:
          "Could not start TikTok login"

      });
    }
  }
);


/* ==========================================
   2. TIKTOK CALLBACK
========================================== */

router.get(
  "/tiktok/callback",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const {
        code,
        state,
        error,
        error_description
      } = req.query;


      /* ======================================
         TIKTOK ERROR
      ====================================== */

      if (error) {

        console.error(
          "TikTok OAuth error:",
          {
            error,
            error_description
          }
        );

        return res.status(400).json({

          success: false,

          message:
            error_description ||
            error ||
            "TikTok authorization failed"

        });
      }


      /* ======================================
         CODE + STATE
      ====================================== */

      if (!code || !state) {

        return res.status(400).json({

          success: false,

          message:
            "Missing TikTok code or state"

        });
      }


      /* ======================================
         VERIFY STATE
      ====================================== */

      if (!verifyState(state)) {

        return res.status(403).json({

          success: false,

          message:
            "Invalid or expired OAuth state"

        });
      }


      /* ======================================
         REDIRECT URI
      ====================================== */

      const redirectUri =
        process.env.TIKTOK_REDIRECT_URI;


      if (!redirectUri) {

        return res.status(500).json({

          success: false,

          message:
            "TIKTOK_REDIRECT_URI is missing"

        });
      }


      /* ======================================
         TOKEN REQUEST
      ====================================== */

      const tokenBody =
        new URLSearchParams();


      tokenBody.set(
        "client_key",
        process.env.TIKTOK_CLIENT_KEY
      );


      tokenBody.set(
        "client_secret",
        process.env.TIKTOK_CLIENT_SECRET
      );


      tokenBody.set(
        "code",
        code
      );


      tokenBody.set(
        "grant_type",
        "authorization_code"
      );


      tokenBody.set(
        "redirect_uri",
        redirectUri
      );


      console.log(
        "Exchanging TikTok authorization code..."
      );


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
              tokenBody.toString()
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
            tokenData.error_description ||
            "Could not get TikTok access token",

          error:
            tokenData.error ||
            null,

          log_id:
            tokenData.log_id ||
            null

        });
      }


      console.log(
        "TikTok token received"
      );

      console.log(
        "Granted scopes:",
        tokenData.scope || "unknown"
      );


      /* ======================================
         GET TIKTOK USER
      ====================================== */

      const profileUrl =
        new URL(TIKTOK_USER_URL);


      /*
       * IMPORTANT:
       *
       * These fields are protected by
       * user.info.profile.
       */

      profileUrl.searchParams.set(
        "fields",
        [
          "open_id",
          "union_id",
          "display_name",
          "avatar_url",
          "username",
          "profile_deep_link",
          "is_verified",
          "bio_description"
        ].join(",")
      );


      const profileResponse =
        await fetch(
          profileUrl.toString(),
          {
            method: "GET",

            headers: {

              Authorization:
                `Bearer ${tokenData.access_token}`,

              Accept:
                "application/json"

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
            profileData.error?.message ||
            profileData.error_description ||
            "Could not get TikTok profile",

          error:
            profileData.error?.code ||
            null,

          log_id:
            profileData.error?.log_id ||
            null

        });
      }


      const tiktokUser =
        profileData.data.user;


      /* ======================================
         CHECK OPEN ID
      ====================================== */

      if (!tiktokUser.open_id) {

        return res.status(400).json({

          success: false,

          message:
            "TikTok did not return open_id"

        });
      }


      /* ======================================
         PROFILE DATA
      ====================================== */

      const username =
        tiktokUser.username ||
        null;


      const profileDeepLink =
        tiktokUser.profile_deep_link ||
        null;


      const isVerified =
        Boolean(
          tiktokUser.is_verified
        );


      console.log(
        "TikTok profile:",
        {
          username,
          profileDeepLink,
          isVerified
        }
      );


      /* ======================================
         DATABASE TRANSACTION
      ====================================== */

      await client.query(
        "BEGIN"
      );


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
          [
            tiktokUser.open_id
          ]
        );


      let user;

      let isNewUser = false;


      /* ======================================
         CREATE NEW USER
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
                  ($7::INTEGER *
                   INTERVAL '1 second')

                ELSE NULL

              END,

              CASE

                WHEN $8::INTEGER IS NOT NULL

                THEN NOW() +
                  ($8::INTEGER *
                   INTERVAL '1 second')

                ELSE NULL

              END,

              30

            )

            RETURNING *
            `,
            [

              tiktokUser.open_id,

              tiktokUser.union_id ||
                null,

              tiktokUser.display_name ||
                null,

              tiktokUser.avatar_url ||
                null,

              tokenData.access_token,

              tokenData.refresh_token ||
                null,

              tokenData.expires_in ||
                null,

              tokenData.refresh_expires_in ||
                null

            ]
          );


        user =
          newUserResult.rows[0];


        /* ====================================
           WELCOME BONUS
        ==================================== */

        await client.query(
          `
          INSERT INTO welcome_bonuses (

            user_id,

            coins_awarded

          )

          VALUES (

            $1,

            30

          )
          `,
          [
            user.id
          ]
        );


        /* ====================================
           COIN TRANSACTION
        ==================================== */

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
          [
            user.id
          ]
        );


      } else {

        /* ======================================
           EXISTING USER
        ====================================== */

        user =
          existingUserResult.rows[0];


        const updatedUserResult =
          await client.query(
            `
            UPDATE users

            SET

              tiktok_union_id =
                COALESCE(
                  $2,
                  tiktok_union_id
                ),

              display_name =
                $3,

              avatar_url =
                $4,

              access_token =
                $5,

              refresh_token =
                COALESCE(
                  $6,
                  refresh_token
                ),

              access_token_expires_at =
                CASE

                  WHEN $7::INTEGER IS NOT NULL

                  THEN NOW() +
                    ($7::INTEGER *
                     INTERVAL '1 second')

                  ELSE
                    access_token_expires_at

                END,

              refresh_token_expires_at =
                CASE

                  WHEN $8::INTEGER IS NOT NULL

                  THEN NOW() +
                    ($8::INTEGER *
                     INTERVAL '1 second')

                  ELSE
                    refresh_token_expires_at

                END,

              updated_at =
                NOW()

            WHERE id = $1

            RETURNING *
            `,
            [

              user.id,

              tiktokUser.union_id ||
                null,

              tiktokUser.display_name ||
                null,

              tiktokUser.avatar_url ||
                null,

              tokenData.access_token,

              tokenData.refresh_token ||
                null,

              tokenData.expires_in ||
                null,

              tokenData.refresh_expires_in ||
                null

            ]
          );


        user =
          updatedUserResult.rows[0];
      }


      /* ======================================
         SAVE TIKTOK ACCOUNT
      ====================================== */

      await client.query(
        `
        INSERT INTO tiktok_accounts (

          user_id,

          open_id,

          username,

          profile_deep_link,

          display_name,

          avatar_url,

          is_verified

        )

        VALUES (

          $1,

          $2,

          $3,

          $4,

          $5,

          $6,

          $7

        )

        ON CONFLICT (open_id)

        DO UPDATE SET

          user_id =
            EXCLUDED.user_id,

          username =
            EXCLUDED.username,

          profile_deep_link =
            EXCLUDED.profile_deep_link,

          display_name =
            EXCLUDED.display_name,

          avatar_url =
            EXCLUDED.avatar_url,

          is_verified =
            EXCLUDED.is_verified,

          updated_at =
            NOW()
        `,
        [

          user.id,

          tiktokUser.open_id,

          username,

          profileDeepLink,

          tiktokUser.display_name ||
            null,

          tiktokUser.avatar_url ||
            null,

          isVerified

        ]
      );


      /* ======================================
         CREATE SESSION
      ====================================== */

      const sessionToken =
        createSessionToken();


      const sessionTokenHash =
        hashToken(
          sessionToken
        );


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

          NOW() +
            INTERVAL '30 days'

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

      await client.query(
        "COMMIT"
      );


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
         REDIRECT
      ====================================== */

      const dashboardUrl =
        isNewUser
          ? "/dashboard.html?welcome=1"
          : "/dashboard.html";


      console.log(
        `TikTok login successful for user ${user.id}`
      );


      return res.redirect(
        dashboardUrl
      );


    } catch (error) {

      try {

        await client.query(
          "ROLLBACK"
        );

      } catch (rollbackError) {

        console.error(
          "Rollback error:",
          rollbackError
        );
      }


      console.error(
        "TikTok authentication error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          "TikTok authentication failed"

      });


    } finally {

      client.release();
    }
  }
);


/* ==========================================
   3. CURRENT USER
========================================== */

router.get(
  "/me",
  async (req, res) => {

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

          message:
            "Not logged in"

        });
      }


      const sessionHash =
        hashToken(
          sessionToken
        );


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

            u.is_admin,

            ta.username
              AS tiktok_username,

            ta.profile_deep_link
              AS tiktok_profile_url,

            ta.is_verified
              AS tiktok_verified

          FROM sessions s

          INNER JOIN users u
            ON u.id = s.user_id

          LEFT JOIN tiktok_accounts ta
            ON ta.user_id = u.id

          WHERE

            s.session_token_hash = $1

            AND s.expires_at > NOW()

          ORDER BY
            ta.updated_at DESC NULLS LAST

          LIMIT 1
          `,
          [
            sessionHash
          ]
        );


      if (
        result.rows.length === 0
      ) {

        clearCookie(
          res,
          "session_token"
        );

        return res.status(401).json({

          success: false,

          message:
            "Session expired"

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
  }
);


/* ==========================================
   4. LOGOUT
========================================== */

router.post(
  "/logout",
  async (req, res) => {

    try {

      const cookies =
        parseCookies(
          req.headers.cookie || ""
        );


      const sessionToken =
        cookies.session_token;


      if (sessionToken) {

        const sessionHash =
          hashToken(
            sessionToken
          );


        await query(
          `
          DELETE FROM sessions

          WHERE
            session_token_hash = $1
          `,
          [
            sessionHash
          ]
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
  }
);


module.exports = router;
