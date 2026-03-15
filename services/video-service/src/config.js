const config = {
  port: Number(process.env.PORT || 8081),
  dbUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || "redis://redis:6379",
  eventStreamKey: process.env.EVENT_STREAM_KEY || "scalastream-events",
  minioEndpoint: process.env.MINIO_ENDPOINT || "minio",
  minioPort: Number(process.env.MINIO_PORT || 9000),
  minioUseSSL: String(process.env.MINIO_USE_SSL || "false") === "true",
  minioAccessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
  minioSecretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
  minioRawBucket: process.env.MINIO_RAW_BUCKET || "raw-videos",
  minioProcessedBucket: process.env.MINIO_PROCESSED_BUCKET || "processed-videos",
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB || 500),
  streamBaseUrl: process.env.STREAM_BASE_URL || "http://localhost:8090/stream",
  recommendationServiceUrl: process.env.RECOMMENDATION_SERVICE_URL || "http://recommendation-service:8082",
  minQualifiedViewSeconds: Number(process.env.MIN_QUALIFIED_VIEW_SECONDS || 8),
  minQualifiedViewCompletionRate: Number(process.env.MIN_QUALIFIED_VIEW_COMPLETION_RATE || 0.2),
  maxSearchQueryLength: Number(process.env.MAX_SEARCH_QUERY_LENGTH || 120),
  maxCommentLength: Number(process.env.MAX_COMMENT_LENGTH || 240),
  adminEmails: String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};

module.exports = config;
