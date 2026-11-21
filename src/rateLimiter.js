import config from './config.js';

// Token bucket per destination hostname. Each bucket holds up to `rateBurst` tokens
// and refills at `ratePerSec`. Sending one request spends one token.
// In-memory on purpose: simple, fast, and correct for a single instance.
const buckets = new Map();

// Returns 0 if a token was spent (send now), otherwise the ms to wait for the next token.
export function takeToken(host) {
  const now = Date.now();
  const bucket = buckets.get(host) ?? { tokens: config.rateBurst, last: now };

  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(config.rateBurst, bucket.tokens + elapsedSec * config.ratePerSec);
  bucket.last = now;
  buckets.set(host, bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 0;
  }
  return Math.ceil(((1 - bucket.tokens) / config.ratePerSec) * 1000);
}
