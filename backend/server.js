const express = require("express");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./auth");
const walletRoutes = require("./wallet");
const earnRoutes = require("./earn");

const { testDatabase } = require("./db");

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
// AUTHENTICATION
// ==========================================

app.use("/api", authRoutes);


// ==========================================
// WALLET
// ==========================================

app.use("/api", walletRoutes);


// ==========================================
// EARN SYSTEM
// ==========================================

app.use("/api", earnRoutes);


// ==========================================
// HOME
// ==========================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "FreeFollowersTik API is running"
  });
});


// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", async (req, res) => {
  try {
    const database = await testDatabase();

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
    message: "API route not found"
  });
});


// ==========================================
// SERVER
// ==========================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `FreeFollowersTik API running on port ${PORT}`
  );
});
