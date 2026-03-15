const express = require("express");
const path = require("path");
const { Readable } = require("stream");

const app = express();
const port = Number(process.env.PORT || 3000);
const configuredApiBaseUrl = process.env.API_BASE_URL || "AUTO";
const configuredStreamBaseUrl = process.env.STREAM_BASE_URL || "AUTO";
const streamGatewayTarget = process.env.STREAM_GATEWAY_URL || "http://stream-gateway:8090";

function resolveHostBase(req, targetPort, suffix = "") {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "");
  const hostHeader = forwardedHost || String(req.headers.host || "localhost");
  const hostname = hostHeader.split(",")[0].trim().split(":")[0] || "localhost";
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${hostname}:${targetPort}${suffix}`;
}

function upstreamUrl(pathname) {
  return new URL(pathname, streamGatewayTarget).toString();
}

async function proxyStreamRequest(req, res, forwardPath) {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!["GET", "HEAD"].includes(req.method)) {
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const upstream = await fetch(upstreamUrl(forwardPath), {
      method: req.method,
      headers: {
        ...(req.headers.range ? { range: req.headers.range } : {}),
        ...(req.headers["if-none-match"] ? { "if-none-match": req.headers["if-none-match"] } : {}),
        ...(req.headers["if-modified-since"] ? { "if-modified-since": req.headers["if-modified-since"] } : {}),
      },
    });

    res.status(upstream.status);
    [
      "content-type",
      "content-length",
      "cache-control",
      "etag",
      "last-modified",
      "accept-ranges",
      "content-range",
    ].forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) {
        res.setHeader(name, value);
      }
    });

    if (!upstream.body || req.method === "HEAD") {
      return res.end();
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    return res.status(503).json({ error: "stream gateway unavailable", detail: error.message });
  }
}

app.get("/config.js", (_req, res) => {
  const req = _req;
  const apiBaseUrl =
    configuredApiBaseUrl.toUpperCase() === "AUTO" ? resolveHostBase(req, 8080) : configuredApiBaseUrl;
  const streamBaseUrl =
    configuredStreamBaseUrl.toUpperCase() === "AUTO"
      ? "/stream"
      : configuredStreamBaseUrl;
  const streamHealthUrl = "/stream-health";

  res.type("application/javascript").send(
    `window.__SCALASTREAM_CONFIG__ = ${JSON.stringify({
      apiBaseUrl,
      streamBaseUrl,
      streamHealthUrl,
    })};`
  );
});

app.get("/vendor/hls.min.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules/hls.js/dist/hls.min.js"));
});

app.get("/stream-health", async (_req, res) => {
  try {
    const upstream = await fetch(upstreamUrl("/health"), { method: "GET" });
    if (!upstream.ok) {
      return res.status(503).json({ ok: false, status: upstream.status });
    }
    const body = (await upstream.text()).trim().toLowerCase();
    return res.json({ ok: body.includes("ok") });
  } catch (error) {
    return res.status(503).json({ ok: false, error: error.message });
  }
});

app.use("/stream", async (req, res) => {
  const forwardPath = `/stream${req.url}`;
  await proxyStreamRequest(req, res, forwardPath);
});

app.use(express.static(path.join(__dirname, "src")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "src/index.html"));
});

app.listen(port, () => {
  console.log(`Frontend available at http://localhost:${port}`);
});
