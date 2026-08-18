const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ...(isProduction
    ? {
        ssl: {
          rejectUnauthorized: false,
        },
      }
    : {}),
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function testDatabase() {
  const result = await pool.query("SELECT NOW() AS time");
  return result.rows[0];
}

module.exports = {
  pool,
  query,
  testDatabase,
};
