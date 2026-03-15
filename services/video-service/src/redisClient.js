const { createClient } = require("redis");
const config = require("./config");

const redis = createClient({ url: config.redisUrl });

redis.on("error", (err) => {
  console.error("Video service Redis error", err);
});

async function connectRedis() {
  if (!redis.isOpen) {
    await redis.connect();
  }
}

module.exports = {
  redis,
  connectRedis,
};
