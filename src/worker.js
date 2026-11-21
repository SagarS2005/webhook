import config from './config.js';
import Job from './models/Job.js';
import { takeToken } from './rateLimiter.js';
import { assertPublicTarget } from './ssrf.js';

let running = false;
let inFlight = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// attempt 1 fails -> wait 2s, attempt 2 -> 4s, attempt 3 -> 8s
const backoffMs = (attempt) => config.baseDelayMs * 2 ** (attempt - 1);

// Atomically claim one due job. findOneAndUpdate is a single atomic operation in MongoDB,
// so two workers can never claim the same job. The second branch re-claims jobs whose
// worker died mid-delivery (lock older than lockTimeoutMs).
function claimNext() {
  const now = Date.now();
  return Job.findOneAndUpdate(
    {
      $or: [
        { status: { $in: ['queued', 'retrying'] }, nextRunAt: { $lte: new Date(now) } },
        { status: 'processing', lockedAt: { $lte: new Date(now - config.lockTimeoutMs) } },
      ],
    },
    { $set: { status: 'processing', lockedAt: new Date(now) } },
    { sort: { nextRunAt: 1 }, new: true },
  );
}

// One HTTP delivery attempt. Never throws: always returns a result describing what happened.
async function deliver(job) {
  const started = Date.now();
  try {
    if (!config.allowPrivateTargets) await assertPublicTarget(job.destinationUrl);

    const res = await fetch(job.destinationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event-Id': job.eventId, // receivers can dedupe on this (delivery is at-least-once)
        'X-Webhook-Job-Id': job.jobId,
      },
      body: JSON.stringify(job.payload),
      redirect: 'manual', // a redirect could point somewhere the SSRF check never saw
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    res.body?.cancel().catch(() => {}); // we only need the status; free the socket

    const retryAfterSec = Number(res.headers.get('retry-after'));
    return {
      code: res.status,
      ok: res.ok,
      retryable: res.status >= 500 || res.status === 429,
      retryAfterMs: Number.isFinite(retryAfterSec) ? Math.min(retryAfterSec * 1000, 60_000) : 0,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'TimeoutError' ? `timeout after ${config.requestTimeoutMs}ms` : (err.cause?.code ?? err.message),
      retryable: !err.permanent, // network errors and timeouts are worth retrying
      retryAfterMs: 0,
      durationMs: Date.now() - started,
    };
  }
}

async function handle(job) {
  try {
    const wait = takeToken(new URL(job.destinationUrl).hostname);
    if (wait > 0) {
      // Over the host's rate limit: this is NOT an attempt. Put the job back for later.
      // Jitter stops a pile of deferred jobs from all waking at the same instant.
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            status: job.attempts > 0 ? 'retrying' : 'queued',
            nextRunAt: new Date(Date.now() + wait + Math.random() * 250),
            lockedAt: null,
          },
        },
      );
      return;
    }

    const result = await deliver(job);
    const attempt = job.attempts + 1;
    const update = { attempts: attempt, lockedAt: null };
    let outcome;

    if (result.ok) {
      outcome = 'success';
      update.status = 'delivered';
    } else if (result.retryable && attempt <= config.maxRetries) {
      outcome = 'retrying';
      update.status = 'retrying';
      update.nextRunAt = new Date(Date.now() + Math.max(backoffMs(attempt), result.retryAfterMs));
    } else {
      outcome = 'failed'; // permanent error (4xx, blocked target) or retries exhausted
      update.status = 'failed';
    }

    await Job.updateOne(
      { _id: job._id },
      {
        $set: update,
        $push: {
          deliveries: {
            attempt,
            outcome,
            responseCode: result.code,
            error: result.error,
            durationMs: result.durationMs,
          },
        },
      },
    );
    console.log(`[worker] ${job.jobId} attempt ${attempt} -> ${outcome} (${result.code ?? result.error})`);
  } catch (err) {
    // e.g. database hiccup. The job stays 'processing' and is re-claimed after lockTimeoutMs.
    console.error(`[worker] ${job.jobId} crashed: ${err.message}`);
  }
}

export function startWorker() {
  running = true;
  (async () => {
    while (running) {
      try {
        while (running && inFlight < config.concurrency) {
          const job = await claimNext();
          if (!job) break;
          inFlight++;
          handle(job).finally(() => inFlight--);
        }
      } catch (err) {
        console.error(`[worker] poll error: ${err.message}`);
      }
      await sleep(config.pollIntervalMs);
    }
  })();
  console.log('[worker] started');
}

// Stop taking new jobs and give in-flight deliveries a moment to finish.
export async function stopWorker(timeoutMs = 10_000) {
  running = false;
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) await sleep(100);
}
