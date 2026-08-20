const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const authRoutes = require("./auth");
const walletRoutes = require("./wallet");
const earnRoutes = require("./earn");
const promotionRoutes = require("./promotion");
const taskQueueRoutes = require("./taskQueue");
const adminRoutes = require("./admin");

const { testDatabase } = require("./db");
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
// FRONTEND
// ==========================================

const frontendPath = path.join(
  __dirname,
  "..",
  "frontend"
);

app.use(
  express.static(frontendPath)
);


// ==========================================
// WEBSITE PAGES
// ==========================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      frontendPath,
      "index.html"
    )
  );
});


app.get("/terms", (req, res) => {
  res.sendFile(
    path.join(
      frontendPath,
      "terms.html"
    )
  );
});


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

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(
      frontendPath,
      "admin.html"
    )
  );
});


// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", async (req, res) => {

  try {

    const database =
      await testDatabase();

    res.json({
      success: true,
      server: "online",
      database: "connected",
      time: database.time
    });

  } catch (error) {

    console.error(
      "Database health check failed:",
      error
    );

    res.status(500).json({
      success: false,
      server: "online",
      database: "disconnected"
    });

  }

});


// ==========================================
// 404 HANDLER
// ==========================================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    message:
      "Page or API route not found"
  });

});


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


    app.listen(PORT, () => {

      console.log(
        `FreeFollowersTik server running on port ${PORT}`
      );

    });

  } catch (error) {

    console.error(
      "❌ Server startup failed:"
    );

    console.error(error);

    process.exit(1);

  }

}


startServer();
