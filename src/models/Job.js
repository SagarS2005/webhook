import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

// One entry per delivery attempt: this is the delivery log.
const deliverySchema = new mongoose.Schema(
  {
    attempt: Number,
    outcome: { type: String, enum: ['success', 'retrying', 'failed'] },
    responseCode: Number,
    error: String,
    durationMs: Number,
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const jobSchema = new mongoose.Schema(
  {
    jobId: { type: String, default: randomUUID, unique: true },
    eventId: { type: String, required: true },
    destinationUrl: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: ['queued', 'processing', 'retrying', 'delivered', 'failed'],
      default: 'queued',
    },
    attempts: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: Date.now }, // when the worker may pick it up
    lockedAt: Date, // set while a worker owns the job; used to recover from crashes

    deliveries: [deliverySchema],
  },
  { timestamps: true, minimize: false }, // minimize:false keeps an empty {} payload
);

// Idempotency: the same event can fan out to different URLs, but never twice to one URL.
jobSchema.index({ eventId: 1, destinationUrl: 1 }, { unique: true });
// The worker's polling query.
jobSchema.index({ status: 1, nextRunAt: 1 });

export default mongoose.model('Job', jobSchema);
