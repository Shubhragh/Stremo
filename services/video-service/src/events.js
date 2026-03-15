const config = require("./config");
const { redis } = require("./redisClient");

async function publishEvent(eventType, payload = {}) {
  const fields = {
    event_type: eventType,
    created_at: new Date().toISOString(),
    ...Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, value == null ? "" : String(value)])
    ),
  };

  await redis.xAdd(config.eventStreamKey, "*", fields);
}

module.exports = {
  publishEvent,
};
