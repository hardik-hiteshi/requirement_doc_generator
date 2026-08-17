import { z } from 'zod';

/**
 * Whether the extraction queue is moving.
 *
 * A stuck job is the failure mode this system has that nobody notices: the upload
 * succeeded, the user is watching a progress indicator, and the worker that claimed
 * the job died. The job is reclaimable — the schema was built for that — but until
 * something looks at the queue, the only signal is a user saying "it's been like
 * this for an hour".
 *
 * So: depth by state, and the age of the oldest work in each of the two states where
 * age means something.
 *
 * ## Ages, not timestamps
 *
 * `oldestQueuedSeconds` rather than a date, because the question is "how long has
 * this been waiting", and answering it from a timestamp means the reader doing
 * arithmetic against a clock they may not share with the server.
 */

export const adminQueueStateSchema = z
  .object({
    counts: z.record(z.string().max(20), z.number().int().nonnegative()),
    /** Age of the oldest job still waiting to be claimed. Absent when none is. */
    oldestQueuedSeconds: z.number().int().nonnegative().optional(),
    /**
     * Age of the oldest claimed job.
     *
     * Compared against the reclaim timeout, this is what distinguishes "a big file is
     * being processed" from "a worker died and nothing has noticed yet".
     */
    oldestClaimedSeconds: z.number().int().nonnegative().optional(),
    /** The reclaim window, so the two ages above can be read against it. */
    claimTimeoutSeconds: z.number().int().positive(),
    /** True when a claimed job has outlived the reclaim window. */
    stalled: z.boolean(),
    observedAt: z.string().datetime(),
  })
  .strict();

export type AdminQueueState = z.infer<typeof adminQueueStateSchema>;

export const adminJobRetrySchema = z
  .object({
    jobId: z.string().min(1).max(64),
  })
  .strict();

export type AdminJobRetry = z.infer<typeof adminJobRetrySchema>;

export const adminJobRetryResultSchema = z
  .object({
    jobId: z.string().max(64),
    status: z.string().max(20),
    attempts: z.number().int().nonnegative(),
  })
  .strict();

export type AdminJobRetryResult = z.infer<typeof adminJobRetryResultSchema>;
