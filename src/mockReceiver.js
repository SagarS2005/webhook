import { Router } from 'express';

// Fake "third-party" endpoints so reviewers can watch each behaviour live.
// Use  <your-base-url>/mock/<name>  as the destinationUrl.
const router = Router();
const hitsByEvent = new Map();

// Always succeeds.
router.post('/ok', (_req, res) => res.json({ received: true }));

// Fails with 503 for the first 2 hits of each eventId, then succeeds.
// Result: attempts 1-2 fail, attempt 3 succeeds (retry + backoff in action).
router.post('/flaky', (req, res) => {
  const id = req.get('X-Webhook-Event-Id') ?? 'unknown';
  const hit = (hitsByEvent.get(id) ?? 0) + 1;
  hitsByEvent.set(id, hit);
  if (hit <= 2) return res.status(503).json({ error: 'temporarily unavailable', hit });
  res.json({ received: true, hit });
});

// Always 429 -> the job is retried 3 times, then marked failed. Retry-After is honoured.
router.post('/rate-limited', (_req, res) => res.set('Retry-After', '1').status(429).json({ error: 'slow down' }));

// Takes 10s, longer than our 5s timeout. The dispatch call still returns 202 instantly.
router.post('/slow', (_req, res) => setTimeout(() => res.json({ received: true }), 10_000));

// 4xx is permanent: no retries, marked failed after one attempt.
router.post('/bad-request', (_req, res) => res.status(400).json({ error: 'bad request' }));

export default router;
