import { Inject, Injectable } from '@nestjs/common';

import { JOB_QUEUE_PORT, type JobQueuePort, type JobRecord } from '../../ports';
import { MongoJobQueueAdapter, type ExtractionJobPayload } from './mongo-job-queue.adapter';

export const EXTRACTION_QUEUE_NAME = 'extraction';

/**
 * The extraction queue, with the idempotency rule in one place.
 *
 * The key is `extraction:<sourceId>:<attempt>` — derived from what the request
 * *means*, never from when it arrived. That is what makes a double-clicked
 * upload button one job, and a genuine second retry two. A timestamp or a random
 * value in the key would make every submission unique, which is the same as
 * having no idempotency at all.
 */
@Injectable()
export class ExtractionQueue {
  constructor(@Inject(JOB_QUEUE_PORT) private readonly queue: JobQueuePort) {}

  async enqueueExtraction(
    projectId: string,
    sourceId: string,
    correlationId: string,
    attempt = 0,
    resumeFrom?: ExtractionJobPayload['resumeFrom'],
  ): Promise<JobRecord> {
    return this.queue.enqueue<ExtractionJobPayload>({
      queue: EXTRACTION_QUEUE_NAME,
      payload: { projectId, sourceId, ...(resumeFrom ? { resumeFrom } : {}) },
      idempotencyKey: `extraction:${sourceId}:${attempt}`,
      correlationId,
    });
  }

  /** The most recent job for a source. What the workspace polls for progress. */
  async statusForSource(sourceId: string): Promise<JobRecord | null> {
    return (this.queue as MongoJobQueueAdapter).latestForSource(sourceId);
  }

  async cancel(jobId: string): Promise<boolean> {
    return this.queue.requestCancellation(jobId);
  }
}
