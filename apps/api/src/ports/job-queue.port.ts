/**
 * Outbound boundary for asynchronous work.
 *
 * First adapter: Phase 3.
 *
 * Extraction, OCR, AI generation and export all outlive an HTTP request. The
 * contract is built around three properties the product needs and that a naive
 * "fire and forget" queue does not give you:
 *
 *  - **Idempotency.** A duplicate submit (double click, retried request, browser
 *    refresh) must not produce a second document.
 *  - **Resumability.** A job reports the stage it reached, so a failure resumes
 *    from there instead of redoing completed work.
 *  - **Observability.** Progress is inspectable while the job runs, because the
 *    user is watching a progress indicator.
 */

export type JobState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Terminal failure that retrying cannot fix (bad input, unsupported file). */
  | 'dead_letter';

export interface JobProgress {
  /** Machine-readable stage id, e.g. `ocr` or `document.generate`. */
  readonly stage: string;
  /** Human-readable description shown in the workspace. */
  readonly label: string;
  readonly percentComplete: number;
}

export interface EnqueueJobRequest<TPayload> {
  readonly queue: string;
  readonly payload: TPayload;
  /**
   * Stable key derived from the request's meaning, not its timing. Enqueuing the
   * same key twice returns the existing job instead of creating a second one.
   */
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
}

export interface JobRecord<TResult = unknown> {
  readonly id: string;
  readonly queue: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly progress?: JobProgress;
  readonly result?: TResult;
  /** User-safe failure summary. Technical detail stays in the logs. */
  readonly failureReason?: string;
  readonly createdAt: Date;
  readonly completedAt?: Date;
}

export interface JobQueuePort {
  /**
   * Enqueues work, or returns the existing job when `idempotencyKey` has already
   * been seen.
   */
  enqueue<TPayload>(request: EnqueueJobRequest<TPayload>): Promise<JobRecord>;

  getJob<TResult>(jobId: string): Promise<JobRecord<TResult> | null>;

  /**
   * Requests cancellation. Cancellation is cooperative: a job that has passed the
   * point of no return runs to completion rather than leaving partial state.
   *
   * @returns whether the job accepted the request.
   */
  requestCancellation(jobId: string): Promise<boolean>;

  /** Re-runs a failed job from its last completed stage. */
  retry(jobId: string): Promise<JobRecord>;
}
