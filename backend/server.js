const express = require("express");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./auth");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Authentication routes
app.use("/api", authRoutes);

// Home / API test
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "FreeFollowersTik API is running"
  });
});

// Server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FreeFollowersTik API running on port ${PORT}`);
});
