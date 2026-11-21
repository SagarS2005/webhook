import 'dotenv/config';

const num = (key, fallback) => Number(process.env[key] ?? fallback);

export default {
  port: num('PORT', 3000),
  mongoUri: process.env.MONGODB_URI,

  // Retry policy
  maxRetries: num('MAX_RETRIES', 3),
  baseDelayMs: num('BASE_DELAY_MS', 2000),
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 5000),

  // Worker (lockTimeoutMs must comfortably exceed requestTimeoutMs)
  pollIntervalMs: num('POLL_INTERVAL_MS', 500),
  concurrency: num('WORKER_CONCURRENCY', 5),
  lockTimeoutMs: num('LOCK_TIMEOUT_MS', 30000),

  // Token bucket, applied per destination hostname
  rateBurst: num('RATE_LIMIT_BURST', 5),
  ratePerSec: num('RATE_LIMIT_PER_SEC', 2),

  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
};
