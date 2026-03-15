const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.dbUrl,
});

pool.on("error", (err) => {
  console.error("Video service PG pool error", err);
});

module.exports = {
  pool,
  query: (text, params = []) => pool.query(text, params),
};
