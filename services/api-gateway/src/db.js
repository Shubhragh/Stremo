const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected PG pool error", err);
});

const query = (text, params = []) => pool.query(text, params);

module.exports = {
  query,
  pool,
};
