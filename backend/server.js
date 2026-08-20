const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const authRoutes = require("./auth");
const walletRoutes = require("./wallet");
const earnRoutes = require("./earn");
const promotionRoutes = require("./promotion");
const taskQueueRoutes = require("./taskQueue");
const adminRoutes = require("./admin");

const { testDatabase, query } = require("./db");
const { initDatabase } = require("./init-db");

const app = express();


// ==========================================
// MIDDLEWARE
// ==========================================

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json());


// ==========================================
// API ROUTES
// ==========================================

app.use("/api", authRoutes);

app.use("/api", walletRoutes);

app.use("/api", earnRoutes);

app.use("/api", promotionRoutes);

app.use("/api", taskQueueRoutes);

app.use("/api", adminRoutes);


// ==========================================
// FRONTEND PATH
// ==========================================

const frontendPath = path.join(
  __dirname,
  "..",
  "frontend"
);


// ==========================================
// COOKIE HELPER
// ==========================================

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
        item
          .slice(0, index)
          .trim();

      const value =
        item
          .slice(index + 1)
          .trim();

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


// ==========================================
// TOKEN HASH
// ==========================================

function hashToken(token) {

  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

}


// ==========================================
// ADMIN PAGE SECURITY
// ==========================================

async function requireAdminPage(
  req,
  res,
  next
) {

  try {

    const cookies =
      parseCookies(
        req.headers.cookie || ""
      );


    const sessionToken =
      cookies.session_token;


    // --------------------------------------
    // NO LOGIN
    // --------------------------------------

    if (!sessionToken) {

      return res.redirect("/");

    }


    const sessionHash =
      hashToken(sessionToken);


    // --------------------------------------
    // FIND USER SESSION
    // --------------------------------------

    const result =
      await query(
        `
        SELECT
          u.id,
          u.display_name,
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


    // --------------------------------------
    // SESSION NOT FOUND / EXPIRED
    // --------------------------------------

    if (
      result.rows.length === 0
    ) {

      return res.redirect("/");

    }


    const user =
      result.rows[0];


    // --------------------------------------
    // NOT ADMIN
    // --------------------------------------

    if (
      !user.is_admin
    ) {

      return res.redirect("/");

    }


    // --------------------------------------
    // BANNED USER
    // --------------------------------------

    if (
      user.is_banned
    ) {

      return res.redirect("/");

    }


    // --------------------------------------
    // INACTIVE USER
    // --------------------------------------

    if (
      !user.is_active
    ) {

      return res.redirect("/");

    }


    // --------------------------------------
    // ADMIN OK
    // --------------------------------------

    req.adminPageUser =
      user;


    next();

  } catch (error) {

    console.error(
      "Admin page authentication error:",
      error
    );


    return res.redirect("/");

  }

}


// ==========================================
// WEBSITE PAGES
// ==========================================


// ------------------------------------------
// HOME
// ------------------------------------------

app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      frontendPath,
      "index.html"
    )
  );

});


// ------------------------------------------
// TERMS
// ------------------------------------------

app.get("/terms", (req, res) => {

  res.sendFile(
    path.join(
      frontendPath,
      "terms.html"
    )
  );

});


// ------------------------------------------
// PRIVACY
// ------------------------------------------

app.get("/privacy", (req, res) => {

  res.sendFile(
    path.join(
      frontendPath,
      "privacy.html"
    )
  );

});


// ==========================================
// ADMIN PAGE
// ==========================================
//
// IMPORTANT:
// These routes MUST come before
// express.static().
//
// This prevents ordinary users from
// opening /admin.html directly.
// ==========================================


// ------------------------------------------
// /admin
// ------------------------------------------

app.get(
  "/admin",
  requireAdminPage,
  (req, res) => {

    res.sendFile(
      path.join(
        frontendPath,
        "admin.html"
      )
    );

  }
);


// ------------------------------------------
// /admin.html
// ------------------------------------------

app.get(
  "/admin.html",
  requireAdminPage,
  (req, res) => {

    res.sendFile(
      path.join(
        frontendPath,
        "admin.html"
      )
    );

  }
);


// ==========================================
// STATIC FRONTEND
// ==========================================

app.use(
  express.static(frontendPath)
);


// ==========================================
// HEALTH CHECK
// ==========================================

app.get(
  "/health",
  async (req, res) => {

    try {

      const database =
        await testDatabase();


      res.json({

        success: true,

        server:
          "online",

        database:
          "connected",

        time:
          database.time

      });

    } catch (error) {

      console.error(
        "Database health check failed:",
        error
      );


      res.status(500).json({

        success: false,

        server:
          "online",

        database:
          "disconnected"

      });

    }

  }
);


// ==========================================
// 404 HANDLER
// ==========================================

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      message:
        "Page or API route not found"

    });

  }
);


// ==========================================
// START SERVER
// ==========================================

const PORT =
  process.env.PORT || 3000;


async function startServer() {

  try {

    console.log(
      "Connecting to database..."
    );


    await testDatabase();


    console.log(
      "Database connected."
    );


    console.log(
      "Initializing database tables..."
    );


    await initDatabase();


    console.log(
      "Database tables are ready."
    );


    app.listen(
      PORT,
      () => {

        console.log(
          `FreeFollowersTik server running on port ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "❌ Server startup failed:"
    );


    console.error(
      error
    );


    process.exit(1);

  }

}


startServer();
