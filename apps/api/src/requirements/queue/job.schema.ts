import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type JobDocument = HydratedDocument<QueuedJob>;

export const JOB_SCHEMA_VERSION = 1;

export const JOB_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'dead_letter',
] as const;

/**
 * A unit of background work.
 *
 * Stored in MongoDB rather than a dedicated broker. That is a real trade-off and
 * it is recorded in ADR-0012: a broker gives better throughput and mature
 * tooling, at the cost of a second stateful service every developer and every
 * environment must run. At this workload — a handful of extractions per project,
 * each taking seconds — the deciding factor is that the database is already
 * required and already backed up, and the collection below gives the three
 * properties the port actually promises.
 *
 * **Idempotency** is a unique index on `idempotencyKey`, so enqueueing the same
 * meaning twice returns the first job instead of creating a second.
 *
 * **Resumability** is `stage`, updated as work progresses, so a retry resumes
 * from the last completed stage rather than redoing it.
 *
 * **Crash recovery** is `claimedAt`. A worker that dies mid-job leaves the
 * document in `running` forever; a claim older than the configured timeout is
 * reclaimable, which is what turns a dead worker into a delay rather than a
 * permanently stuck source.
 */
@Schema({
  collection: 'extraction_jobs',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class QueuedJob {
  // Every @Prop states its type explicitly rather than relying on emitted
  // decorator metadata, which differs between compilers for optional properties
  // and does not exist at all for a union of string literals.
  @Prop({ type: String, required: true, index: true })
  jobId!: string;

  @Prop({ type: String, required: true, index: true })
  queue!: string;

  /**
   * Derived from what the job *means*, not when it was asked for. For extraction
   * that is the source plus its attempt number, so a double-clicked retry is one
   * job and a genuine second retry is two.
   */
  @Prop({ type: String, required: true, unique: true })
  idempotencyKey!: string;

  @Prop({ type: String, required: true, enum: JOB_STATES, index: true })
  state!: (typeof JOB_STATES)[number];

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, index: true })
  sourceId!: string;

  @Prop({ type: String, required: true })
  correlationId!: string;

  @Prop({ type: Number, required: true, default: 0 })
  attempts!: number;

  @Prop({ type: Number, required: true })
  maxAttempts!: number;

  /** The last stage that completed, so a retry knows where to resume. */
  @Prop({ type: String })
  stage?: string;

  @Prop({ type: String })
  stageLabel?: string;

  @Prop({ type: Number, required: true, default: 0 })
  percentComplete!: number;

  /** Not before this instant. Carries the exponential backoff between attempts. */
  @Prop({ type: Date, required: true, index: true })
  runAfter!: Date;

  /** Set when a worker takes the job; cleared when it lets go. */
  @Prop({ type: Date })
  claimedAt?: Date;

  @Prop({ type: String })
  claimedBy?: string;

  /** Cooperative: the worker checks this between stages. */
  @Prop({ type: Boolean, required: true, default: false })
  cancellationRequested!: boolean;

  /** Stable code. Safe to map to a user-facing message. */
  @Prop({ type: String })
  failureCode?: string;

  /** Operator detail. Never returned to a caller. */
  @Prop({ type: String })
  failureDetail?: string;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Number, required: true, default: JOB_SCHEMA_VERSION })
  schemaVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const QueuedJobSchema = SchemaFactory.createForClass(QueuedJob);

/*
 * The claim query is `{state, runAfter}` sorted by `runAfter` — this index is
 * what stops every poll from scanning the collection as completed jobs pile up.
 */
QueuedJobSchema.index({ state: 1, runAfter: 1 }, { name: 'claimable' });
QueuedJobSchema.index({ jobId: 1 }, { name: 'job_id', unique: true });
QueuedJobSchema.index({ sourceId: 1, createdAt: -1 }, { name: 'source_history' });
