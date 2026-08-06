import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AppConfigService } from '../../config/app-config.service';
import type { EnqueueJobRequest, JobQueuePort, JobRecord } from '../../ports';
import { QueuedJob, type JobDocument } from './job.schema';

/** What an extraction job carries. Small by design — the source is the state. */
export interface ExtractionJobPayload {
  readonly projectId: string;
  readonly sourceId: string;
  /** Where a retry resumes. Absent means "from the beginning". */
  readonly resumeFrom?: 'validation' | 'extraction' | 'ocr';
}

export interface ClaimedJob {
  readonly jobId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly correlationId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly resumeFrom?: string;
}

/**
 * `JobQueuePort` over a MongoDB collection.
 *
 * Claiming is a single `findOneAndUpdate`, which is atomic in MongoDB. That one
 * fact is what makes this safe with several workers: two of them racing for the
 * same job means one update succeeds and the other matches nothing, with no
 * lock, no lease renewal and no window in which both believe they own it.
 *
 * Polling rather than pushing. It costs one indexed query per interval per
 * worker, which at this workload is nothing, and it removes the failure mode
 * where a missed notification strands a job forever.
 */
@Injectable()
export class MongoJobQueueAdapter implements JobQueuePort {
  private readonly logger = new Logger(MongoJobQueueAdapter.name);
  private readonly workerId = `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;

  constructor(
    @InjectModel(QueuedJob.name) private readonly jobs: Model<QueuedJob>,
    private readonly config: AppConfigService,
  ) {}

  async enqueue<TPayload>(request: EnqueueJobRequest<TPayload>): Promise<JobRecord> {
    const payload = request.payload as ExtractionJobPayload;
    const now = new Date();

    // Upsert on the idempotency key. `$setOnInsert` means a repeat submission
    // touches nothing — the original job's state, attempts and progress survive,
    // which is what makes a double-click harmless rather than merely tolerable.
    const document = await this.jobs.findOneAndUpdate(
      { idempotencyKey: request.idempotencyKey },
      {
        $setOnInsert: {
          jobId: `job_${randomBytes(12).toString('hex')}`,
          queue: request.queue,
          idempotencyKey: request.idempotencyKey,
          state: 'queued',
          projectId: payload.projectId,
          sourceId: payload.sourceId,
          correlationId: request.correlationId,
          attempts: 0,
          maxAttempts: request.maxAttempts ?? this.config.extraction.maxAttempts,
          stage: payload.resumeFrom,
          percentComplete: 0,
          runAfter: new Date(now.getTime() + (request.delayMs ?? 0)),
          cancellationRequested: false,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return toRecord(document);
  }

  async getJob<TResult>(jobId: string): Promise<JobRecord<TResult> | null> {
    const document = await this.jobs.findOne({ jobId });
    return document ? (toRecord(document) as JobRecord<TResult>) : null;
  }

  /** The most recent job for a source. What the UI polls for progress. */
  async latestForSource(sourceId: string): Promise<JobRecord | null> {
    const document = await this.jobs.findOne({ sourceId }).sort({ createdAt: -1 });
    return document ? toRecord(document) : null;
  }

  async requestCancellation(jobId: string): Promise<boolean> {
    const result = await this.jobs.findOneAndUpdate(
      { jobId, state: { $in: ['queued', 'running'] } },
      { $set: { cancellationRequested: true } },
      { new: true },
    );

    // A job past the point of no return is left to finish. Killing it mid-write
    // would leave a source half-extracted, which is worse than a few more
    // seconds of work nobody wanted.
    return result !== null;
  }

  async retry(jobId: string): Promise<JobRecord> {
    const document = await this.jobs.findOneAndUpdate(
      { jobId, state: { $in: ['failed', 'dead_letter'] } },
      {
        $set: {
          state: 'queued',
          runAfter: new Date(),
          cancellationRequested: false,
          claimedAt: null,
          claimedBy: null,
        },
        $unset: { failureCode: '', failureDetail: '', completedAt: '' },
      },
      { new: true },
    );

    if (!document) {
      throw new Error(`Job ${jobId} is not in a retryable state.`);
    }

    return toRecord(document);
  }

  /**
   * Takes the next runnable job, or returns null.
   *
   * "Runnable" is either never claimed, or claimed so long ago that the worker
   * holding it must be gone. Both are expressed in the filter, so the decision
   * and the claim are the same atomic operation.
   */
  async claimNext(queue: string): Promise<ClaimedJob | null> {
    const now = new Date();
    const staleClaim = new Date(now.getTime() - this.config.extraction.claimTimeoutMs);

    const document = await this.jobs.findOneAndUpdate(
      {
        queue,
        runAfter: { $lte: now },
        $or: [{ state: 'queued' }, { state: 'running', claimedAt: { $lt: staleClaim } }],
      },
      {
        $set: { state: 'running', claimedAt: now, claimedBy: this.workerId },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { runAfter: 1 } },
    );

    if (!document) {
      return null;
    }

    if (document.attempts > 1) {
      this.logger.warn(
        { jobId: document.jobId, attempt: document.attempts },
        'Re-running a job — previous attempt did not complete',
      );
    }

    return {
      jobId: document.jobId,
      projectId: document.projectId,
      sourceId: document.sourceId,
      correlationId: document.correlationId,
      attempts: document.attempts,
      maxAttempts: document.maxAttempts,
      ...(document.stage ? { resumeFrom: document.stage } : {}),
    };
  }

  async reportProgress(
    jobId: string,
    stage: string,
    label: string,
    percent: number,
  ): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: {
          stage,
          stageLabel: label,
          percentComplete: Math.max(0, Math.min(100, Math.round(percent))),
          // Refreshed with progress so a long but healthy job is not mistaken
          // for a dead one and reclaimed underneath itself.
          claimedAt: new Date(),
        },
      },
    );
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    const document = await this.jobs.findOne({ jobId }, { cancellationRequested: 1 });
    return document?.cancellationRequested ?? false;
  }

  async complete(jobId: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: { state: 'completed', percentComplete: 100, completedAt: new Date() },
        $unset: { claimedAt: '', claimedBy: '' },
      },
    );
  }

  async cancel(jobId: string): Promise<void> {
    await this.jobs.updateOne(
      { jobId },
      {
        $set: { state: 'cancelled', completedAt: new Date() },
        $unset: { claimedAt: '', claimedBy: '' },
      },
    );
  }

  /**
   * Records a failure and decides what happens next.
   *
   * A non-retryable failure goes straight to `dead_letter`. Retrying a file that
   * is the wrong format, or corrupt, cannot succeed — it only delays the moment
   * the user is told the truth, three times over.
   */
  async fail(
    jobId: string,
    failureCode: string,
    detail: string,
    retryable: boolean,
  ): Promise<'retrying' | 'dead_letter' | 'failed'> {
    const document = await this.jobs.findOne({ jobId });

    if (!document) {
      return 'failed';
    }

    if (!retryable) {
      await this.jobs.updateOne(
        { jobId },
        {
          $set: {
            state: 'dead_letter',
            failureCode,
            failureDetail: detail,
            completedAt: new Date(),
          },
          $unset: { claimedAt: '', claimedBy: '' },
        },
      );
      return 'dead_letter';
    }

    if (document.attempts >= document.maxAttempts) {
      await this.jobs.updateOne(
        { jobId },
        {
          $set: { state: 'failed', failureCode, failureDetail: detail, completedAt: new Date() },
          $unset: { claimedAt: '', claimedBy: '' },
        },
      );
      return 'failed';
    }

    // Exponential backoff, from the configured base. A worker that is failing
    // because something downstream is overloaded should not hammer it.
    const backoff = this.config.extraction.retryBackoffMs * 2 ** (document.attempts - 1);

    await this.jobs.updateOne(
      { jobId },
      {
        $set: {
          state: 'queued',
          failureCode,
          failureDetail: detail,
          runAfter: new Date(Date.now() + backoff),
        },
        $unset: { claimedAt: '', claimedBy: '' },
      },
    );

    return 'retrying';
  }

  /** Removes every job for a project. Called when a project is deleted. */
  async deleteForProject(projectId: string): Promise<void> {
    await this.jobs.deleteMany({ projectId });
  }
}

function toRecord(document: JobDocument): JobRecord {
  return {
    id: document.jobId,
    queue: document.queue,
    state: document.state,
    attempts: document.attempts,
    ...(document.stage
      ? {
          progress: {
            stage: document.stage,
            label: document.stageLabel ?? document.stage,
            percentComplete: document.percentComplete,
          },
        }
      : {}),
    ...(document.failureCode ? { failureReason: document.failureCode } : {}),
    createdAt: document.createdAt,
    ...(document.completedAt ? { completedAt: document.completedAt } : {}),
  };
}
