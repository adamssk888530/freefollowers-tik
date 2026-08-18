const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USER_URL = "https://open.tiktokapis.com/v2/user/info/";

function createState() {
  return crypto.randomBytes(32).toString("hex");
}

// 1. Start TikTok Login
router.get("/tiktok/login", (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;

  if (!clientKey || !redirectUri) {
    return res.status(500).json({
      success: false,
      message: "TikTok configuration is missing"
    });
  }

  const state = createState();

  res.setHeader(
    "Set-Cookie",
    `tiktok_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`
  );

  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: "user.info.basic",
    redirect_uri: redirectUri,
    state
  });

  res.redirect(`${TIKTOK_AUTH_URL}?${params.toString()}`);
});

// 2. TikTok Callback
router.get("/tiktok/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).json({
        success: false,
        message: error_description || error
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        message: "Missing TikTok authorization code or state"
      });
    }

    const cookies = req.headers.cookie || "";
    const stateCookie = cookies
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("tiktok_oauth_state="));

    const savedState = stateCookie
      ? decodeURIComponent(stateCookie.split("=")[1])
      : null;

    if (!savedState || savedState !== state) {
      return res.status(403).json({
        success: false,
        message: "Invalid OAuth state"
      });
    }

    const tokenResponse = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: process.env.TIKTOK_REDIRECT_URI
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(400).json({
        success: false,
        message: "Could not get TikTok access token",
        error: tokenData
      });
    }

    // 3. Get TikTok user profile
    const profileResponse = await fetch(
      `${TIKTOK_USER_URL}?fields=open_id,display_name,avatar_url`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const profileData = await profileResponse.json();

    if (!profileResponse.ok || !profileData.data?.user) {
      return res.status(400).json({
        success: false,
        message: "Could not get TikTok profile",
        error: profileData
      });
    }

    const tiktokUser = profileData.data.user;

    // Temporary response.
    // Later we will save this user in PostgreSQL
    // and create the real login session.
    return res.json({
      success: true,
      message: "TikTok login successful",
      user: {
        open_id: tiktokUser.open_id,
        display_name: tiktokUser.display_name,
        avatar_url: tiktokUser.avatar_url
      }
    });

  } catch (error) {
    console.error("TikTok OAuth error:", error);

    return res.status(500).json({
      success: false,
      message: "TikTok authentication failed"
    });
  }
});

module.exports = router;
