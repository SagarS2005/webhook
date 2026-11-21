import mongoose from 'mongoose';
import app from './app.js';
import config from './config.js';
import Job from './models/Job.js';
import { startWorker, stopWorker } from './worker.js';

if (!config.mongoUri) {
  console.error('MONGODB_URI is required (see .env.example)');
  process.exit(1);
}

await mongoose.connect(config.mongoUri);
await Job.init(); // make sure the unique + polling indexes exist before serving traffic

const server = app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));

// The worker runs in the same process as the API. That fits free hosting (one service),
// and the queue lives in MongoDB, so splitting them into two services later needs no code change.
startWorker();

async function shutdown() {
  server.close();
  await stopWorker();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
