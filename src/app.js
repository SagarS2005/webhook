import express from 'express';
import Job from './models/Job.js';
import mockReceiver from './mockReceiver.js';
import { validateDispatch } from './validate.js';
import dns from "dns"

dns.setServers(["1.1.1.1", "8.8.8.8"])

const app = express();
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));


app.post('/api/webhooks/dispatch', async (req, res) => {
  const errors = validateDispatch(req.body);
  if (errors.length) return res.status(400).json({ status: 'error', errors });

  const { destinationUrl, eventId, payload } = req.body;
  try {
    const job = await Job.create({ destinationUrl, eventId, payload });
    return res.status(202).json({ status: 'queued', jobId: job.jobId });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Same eventId + destinationUrl already accepted: return the original job (idempotent).
    const existing = await Job.findOne({ eventId, destinationUrl }).select('jobId status');
    return res.status(202).json({ status: existing.status, jobId: existing.jobId, duplicate: true });
  }
});

// Status + full delivery log for one job.
app.get('/api/webhooks/jobs/:jobId', async (req, res) => {
  const job = await Job.findOne({ jobId: req.params.jobId }).select('-_id -__v').lean();
  if (!job) return res.status(404).json({ status: 'error', message: 'Job not found' });
  res.json(job);
});

// Latest 20 jobs, optionally filtered: ?status=failed
app.get('/api/webhooks/jobs', async (req, res) => {
  const filter = req.query.status ? { status: String(req.query.status) } : {};
  const jobs = await Job.find(filter)
    .sort({ createdAt: -1 })
    .limit(20)
    .select('-_id jobId eventId destinationUrl status attempts createdAt')
    .lean();
  res.json(jobs);
});

app.use('/mock', mockReceiver);

app.use((_req, res) => res.status(404).json({ status: 'error', message: 'Not found' }));

// Express 5 forwards errors from async handlers here automatically.
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ status: 'error', message: status >= 500 ? 'Internal server error' : err.message });
});

export default app;
