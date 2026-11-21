# Distributed Webhook Dispatcher

Accepts events over HTTP, queues them, and delivers them to third-party URLs in the background with retries, exponential backoff, and per-domain rate limiting.

**Live URL:** `https://<your-app>.onrender.com` _(replace after deploying)_

```
Client ──POST /api/webhooks/dispatch──▶ validate ─▶ save job (MongoDB) ─▶ 202 Accepted
                                                          │
                      worker loop (same process) ◀── polls, atomically claims due jobs
                           │
                           ├─ rate-limit check (token bucket per host) ── over limit? defer, no attempt used
                           ├─ POST payload to destinationUrl (5s timeout)
                           └─ log attempt ─▶ delivered │ retrying (2s, 4s, 8s) │ failed
```

## Architecture choices (and why)

| Concern | Choice | Why |
|---|---|---|
| Non-blocking API | Endpoint only validates and inserts a job, then returns 202 | Response time never depends on the destination. A 10s downstream costs the API nothing. |
| Queue + state | A MongoDB collection (`jobs`) | One dependency, state survives restarts, free on Atlas. No Redis to host, and no polling cost against Redis free-tier command limits. Trade-off: ~500ms pickup latency and lower peak throughput than Redis/BullMQ. |
| No double-processing | Workers claim jobs with an atomic `findOneAndUpdate` | Two workers can never take the same job. |
| Crash safety | `lockedAt` + timeout: a job stuck in `processing` is re-claimed after 30s | A crash mid-delivery loses nothing. The cost is **at-least-once** delivery, so every request carries `X-Webhook-Event-Id` for receivers to dedupe. |
| Retries | 4 attempts total (1 + 3 retries), delay `2s * 2^(n-1)` = 2s, 4s, 8s | Spacing retries gives a struggling server room to recover. Honours `Retry-After` (capped at 60s). |
| What is retried | 5xx, 429, timeouts, network errors | These are transient. Other 4xx responses are permanent, so they fail immediately instead of wasting retries. |
| Rate limiting | In-memory token bucket per destination hostname (burst 5, 2 req/s) | Prevents flooding one domain. Over-limit jobs are deferred, not dropped, and do not consume a retry. Limitation: per-process, so with several instances the limit multiplies. Move the buckets to Redis to scale out. |
| Idempotency | Unique index on `(eventId, destinationUrl)` | A client re-sending the same event gets the original `jobId` back (`duplicate: true`), and the event is not delivered twice. The same event can still fan out to different URLs. |
| Delivery log | `deliveries[]` embedded in each job: attempt, outcome, response code, error, duration | One read gives the full history. Exposed via `GET /api/webhooks/jobs/:jobId`. |
| SSRF guard | The worker resolves DNS and refuses private/internal IPs; redirects are not followed | A user-supplied URL must not reach internal services or cloud metadata. Done in the worker so ingestion stays instant. Known limit: DNS can change between the check and the request. |
| Worker placement | Runs in the same process as the API | Free hosts give one service. Since the queue is in MongoDB, the worker can be split out later without code changes. |

## Run locally

```bash
npm install
npm run dev
npm test                 # unit tests (validation, rate limiter, SSRF guard)
```

`ALLOW_PRIVATE_TARGETS=true` in `.env.example` lets you deliver to the built-in `/mock` endpoints on localhost. Leave it unset in production.

## Test it (curl)

```bash
BASE=https://webhook-4ac8.onrender.com
send() { curl -s -w "\n(%{time_total}s)\n" -X POST "$BASE/api/webhooks/dispatch" \
  -H 'Content-Type: application/json' \
  -d "{\"destinationUrl\":\"$BASE/mock/$1\",\"eventId\":\"$2\",\"payload\":{\"event\":\"user.signup\",\"userId\":\"usr_999\"}}"; }
```

**1. Happy path**
```bash
send ok evt_1                      # -> 202 {"status":"queued","jobId":"..."}
curl -s $BASE/api/webhooks/jobs/<jobId>   # -> status "delivered", 1 delivery
```

**2. Retry + backoff**: fails twice with 503, succeeds on attempt 3 (~6s)
```bash
send flaky evt_2
sleep 8; curl -s $BASE/api/webhooks/jobs/<jobId>   # deliveries: 503, 503, 200
```

**3. Non-blocking**: the destination takes 10s but the API answers instantly
```bash
send slow evt_3                    # time_total is a few ms, still 202
```

**4. Retries exhausted**: always 429, so 4 attempts then `failed`
```bash
send rate-limited evt_4
```

**5. Permanent error**: 400 is not retried, so exactly 1 attempt then `failed`
```bash
send bad-request evt_5
```

**6. Rate limiting**: 20 jobs to one host are spread out (burst 5, then ~2/s)
```bash
for i in $(seq 1 20); do send ok burst_$i >/dev/null; done
sleep 12; curl -s "$BASE/api/webhooks/jobs"     # all delivered; compare delivery timestamps
```

**7. Idempotency and validation**
```bash
send ok evt_1                                    # same event again -> same jobId, "duplicate": true
curl -s -X POST $BASE/api/webhooks/dispatch -H 'Content-Type: application/json' -d '{"eventId":"x"}'   # -> 400 with reasons
```

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/webhooks/dispatch` | Body: `destinationUrl`, `eventId`, `payload` (object). Returns `202 {status, jobId}`. |
| GET | `/api/webhooks/jobs/:jobId` | Status, attempt count, full delivery log. |
| GET | `/api/webhooks/jobs?status=failed` | Latest 20 jobs, optional status filter. |
| POST | `/mock/{ok,flaky,rate-limited,slow,bad-request}` | Built-in fake receivers for testing. |
| GET | `/health` | Liveness. |

## Deploy (Render + MongoDB Atlas, both free)

1. Create a free **MongoDB Atlas** cluster, add a database user, and allow access from anywhere (`0.0.0.0/0`). Copy the connection string.
2. Push this repo to GitHub.
3. On **Render**: New, Web Service, connect the repo. Build `npm install`, start `npm start`.
4. Environment variables: `MONGODB_URI` (required). Do **not** set `ALLOW_PRIVATE_TARGETS`.
5. Test with the curl commands above, using your Render URL as `BASE`. The `/mock` endpoints are public, so they pass the SSRF check.

Note: the Render free tier sleeps when idle, so the first request after a pause takes ~30s to wake. Retries still complete because the service stays awake while jobs are pending.


