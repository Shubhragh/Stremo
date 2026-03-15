require("dotenv").config();

const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const morgan = require("morgan");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { query, pool } = require("./db");
const { generateToken, optionalUser } = require("./auth");

const app = express();
const port = process.env.PORT || 8080;
const videoServiceUrl = process.env.VIDEO_SERVICE_URL || "http://video-service:8081";
const recommendationServiceUrl =
  process.env.RECOMMENDATION_SERVICE_URL || "http://recommendation-service:8082";

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(morgan("dev"));
app.use(optionalUser);

app.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    return res.json({ ok: true, service: "api-gateway" });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/auth/register", express.json(), async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "email and password(>=6) are required" });
  }

  try {
    const existing = await query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: "email already registered" });
    }

    const hash = await bcrypt.hash(password, 10);
    const created = await query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [email.toLowerCase(), hash]
    );

    const user = created.rows[0];
    const token = generateToken(user);
    return res.status(201).json({ token, user });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/auth/login", express.json(), async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    const result = await query(
      "SELECT id, email, password_hash FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const token = generateToken(user);
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/auth/me", async (req, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: "authentication required" });
  }

  try {
    const result = await query("SELECT id, email, created_at FROM users WHERE id = $1", [req.user.id]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: "session is invalid" });
    }
    return res.json({ user: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const withIdentityProxy = (target, basePath) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    proxyTimeout: 600000,
    timeout: 600000,
    pathRewrite: (path) => `${basePath}${path}`,
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.user?.id) {
          proxyReq.setHeader("x-user-id", req.user.id);
          proxyReq.setHeader("x-user-email", req.user.email || "");
        }
      },
    },
  });

app.use("/videos", withIdentityProxy(videoServiceUrl, "/videos"));
app.use("/feed", withIdentityProxy(recommendationServiceUrl, "/feed"));
app.use("/internal", withIdentityProxy(videoServiceUrl, "/internal"));

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

app.listen(port, () => {
  console.log(`API gateway listening on port ${port}`);
});

const shutdown = async () => {
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
