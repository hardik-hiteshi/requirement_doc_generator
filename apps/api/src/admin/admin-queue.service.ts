import { Inject, Injectable } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { API_ERROR_CODES, type AdminJobRetryResult, type AdminQueueState } from '@wdrg/contracts';
import type { Connection } from 'mongoose';

import { AppException } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { JOB_QUEUE_PORT, type JobQueuePort } from '../ports';

/**
 * Whether extraction is moving.
 *
 * This is the failure this system has that nobody sees. An upload succeeds, the
 * workspace shows a progress indicator, and the worker that claimed the job dies. The
 * job is reclaimable — `claimedAt` and the reclaim timeout were built for exactly
 * that — but nothing looks at the queue, so the first signal is a person saying it
 * has been like this for an hour.
 *
 * Two ages answer it. The oldest queued job says whether work is being picked up at
 * all; the oldest claimed job, read against the reclaim window, distinguishes "a
 * large file is being processed" from "a worker died and the reclaim has not fired
 * yet". `stalled` states that conclusion rather than leaving an operator to compute
 * it from two numbers and a configuration value.
 */
@Injectable()
export class AdminQueueService {
  constructor(
    @Inject(getConnectionToken()) private readonly connection: Connection,
    @Inject(JOB_QUEUE_PORT) private readonly queue: JobQueuePort,
    private readonly config: AppConfigService,
  ) {}

  async state(now = new Date()): Promise<AdminQueueState> {
    const grouped = await this.jobs()
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();

    const oldestQueued = await this.oldest({ status: 'queued' }, 'availableAt');
    const oldestClaimed = await this.oldest({ status: 'running' }, 'claimedAt');

    const claimTimeoutSeconds = Math.round(this.config.extraction.claimTimeoutMs / 1_000);
    const claimedAge = this.ageSeconds(oldestClaimed, now);

    return {
      counts: Object.fromEntries(grouped.map((entry) => [entry._id, entry.count])),
      ...(oldestQueued ? { oldestQueuedSeconds: this.ageSeconds(oldestQueued, now) ?? 0 } : {}),
      ...(claimedAge !== undefined ? { oldestClaimedSeconds: claimedAge } : {}),
      claimTimeoutSeconds,
      /*
       * A claimed job older than the reclaim window means the reclaim has not run, or
       * has run and been claimed again by another dying worker. Either way it is the
       * state worth surfacing.
       */
      stalled: claimedAge !== undefined && claimedAge > claimTimeoutSeconds,
      observedAt: now.toISOString(),
    };
  }

  /**
   * Sends one job back to the queue.
   *
   * Through the existing port, so the transition is the same one the retry endpoint
   * for a source already performs — a second implementation could disagree about what
   * resetting a job means, and this is not the place to find that out.
   */
  async retry(jobId: string): Promise<AdminJobRetryResult> {
    try {
      const job = await this.queue.retry(jobId);

      return { jobId: job.id, status: job.state, attempts: job.attempts };
    } catch {
      /*
       * The port throws a plain error when a job is missing or is not in a retryable
       * state, which reaches a caller as a 500. For an operator typing a job id by hand
       * that is the wrong answer twice over: it reads as "the system is broken" rather
       * than "no such job", and a 500 in the error counter is a real incident signal
       * that this would pollute.
       *
       * Both cases answer identically and deliberately: an operator cannot use the
       * distinction to discover which job ids exist.
       */
      throw new AppException(API_ERROR_CODES.NOT_FOUND, {
        message: 'No job with that id is waiting to be retried.',
      });
    }
  }

  private async oldest(filter: Record<string, unknown>, field: string): Promise<Date | undefined> {
    const rows = await this.jobs()
      .find(filter)
      .sort({ [field]: 1 })
      .limit(1)
      .project<Record<string, unknown>>({ [field]: 1 })
      .toArray();

    const value: unknown = rows[0]?.[field];

    return value instanceof Date ? value : undefined;
  }

  private ageSeconds(at: Date | undefined, now: Date): number | undefined {
    if (!at) {
      return undefined;
    }

    /* Never negative: a clock skew should not produce a nonsensical age. */
    return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1_000));
  }

  private jobs() {
    return this.connection.collection('extraction_jobs');
  }
}
