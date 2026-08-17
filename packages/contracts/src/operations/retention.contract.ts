import { z } from 'zod';

import { type ProjectStatus } from '../project/project-status';

/**
 * When stored data stops being kept.
 *
 * Two separate clocks, because "unusable" and "gone" are different promises.
 *
 * 1. **Expiry** already happens without this: a project past `expiresAt` reads as
 *    `EXPIRED` and refuses writes, derived on access. What was missing is that the
 *    stored status never caught up, so an operator querying the database saw
 *    `ACTIVE` for a project the application had long since frozen. The sweep
 *    materialises what the domain already decided.
 *
 * 2. **Purging** removes content. It only ever applies to a project that is already
 *    beyond use — deletion requested, or expired long enough ago that nobody is
 *    coming back — and it happens after a window in which the project is visibly
 *    pending rather than instantly.
 *
 * ## What survives a purge
 *
 * The audit trail. A purge removes the content a project accumulated — its
 * requirements, documents, estimates, uploaded files — and leaves the record that
 * those things existed and were removed. Deleting the trail with the data would
 * mean a deletion could not be accounted for afterwards, which is precisely when
 * somebody asks.
 *
 * This is also why there is no TTL index on `expiresAt`: MongoDB would delete the
 * project document outright, erasing the subject of its own audit trail and
 * skipping `DELETION_PENDING` entirely.
 */

export const RETENTION_LIMITS = {
  /** Days a deletion request stays pending before content is purged. */
  deletionGraceDays: { min: 0, max: 365, default: 7 },
  /** Days after expiry before an abandoned project is queued for deletion. */
  expiredGraceDays: { min: 1, max: 3_650, default: 90 },
  /** Projects handled per sweep, so one tick cannot monopolise the database. */
  batchSize: { min: 1, max: 500, default: 25 },
} as const;

export const retentionPolicySchema = z
  .object({
    deletionGraceDays: z
      .number()
      .int()
      .min(RETENTION_LIMITS.deletionGraceDays.min)
      .max(RETENTION_LIMITS.deletionGraceDays.max),
    expiredGraceDays: z
      .number()
      .int()
      .min(RETENTION_LIMITS.expiredGraceDays.min)
      .max(RETENTION_LIMITS.expiredGraceDays.max),
    batchSize: z
      .number()
      .int()
      .min(RETENTION_LIMITS.batchSize.min)
      .max(RETENTION_LIMITS.batchSize.max),
  })
  .strict();

export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

/** What one sweep did. Counts only — never which projects, never their content. */
export const retentionSweepResultSchema = z
  .object({
    /** Projects whose stored status caught up with the expiry they already had. */
    expired: z.number().int().nonnegative(),
    /** Expired-and-abandoned projects moved to `DELETION_PENDING`. */
    queuedForDeletion: z.number().int().nonnegative(),
    /** Projects whose content was removed and which are now `DELETED`. */
    purged: z.number().int().nonnegative(),
    /** Documents removed across every collection, summed. */
    recordsRemoved: z.number().int().nonnegative(),
    /** Projects whose storage prefix was removed. */
    storagePrefixesRemoved: z.number().int().nonnegative(),
    /** Projects that could not be completed this sweep. */
    failed: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();

export type RetentionSweepResult = z.infer<typeof retentionSweepResultSchema>;

/**
 * Whether a project may have its content removed right now.
 *
 * Written as a pure function, and the only place eligibility is decided, because
 * a purge is irreversible: a rule spread across two call sites is a rule that will
 * eventually disagree with itself over which projects are safe to destroy.
 *
 * A project is eligible only from `DELETION_PENDING`, and only once the grace
 * window has passed. An expired project is never purged directly — it is queued
 * first, which gives the same visible pending state a requested deletion has.
 */
export function isPurgeEligible(input: {
  readonly status: ProjectStatus;
  readonly deletionRequestedAt: Date | undefined;
  readonly now: Date;
  readonly policy: RetentionPolicy;
}): boolean {
  if (input.status !== 'DELETION_PENDING') {
    return false;
  }

  /*
   * No timestamp means the pending state predates this field. Treated as not yet
   * eligible rather than as infinitely old: the safe reading of missing data about
   * a destructive operation is "wait", and the next deletion request will stamp it.
   */
  if (!input.deletionRequestedAt) {
    return false;
  }

  const graceMs = input.policy.deletionGraceDays * 24 * 60 * 60 * 1000;

  return input.now.getTime() - input.deletionRequestedAt.getTime() >= graceMs;
}

/** Whether an expired project has been abandoned long enough to queue for deletion. */
export function isAbandoned(input: {
  readonly status: ProjectStatus;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly policy: RetentionPolicy;
}): boolean {
  if (input.status !== 'EXPIRED') {
    return false;
  }

  const graceMs = input.policy.expiredGraceDays * 24 * 60 * 60 * 1000;

  return input.now.getTime() - input.expiresAt.getTime() >= graceMs;
}

/**
 * Every collection a project's content lives in.
 *
 * Declared in one list rather than discovered, so adding a collection without
 * adding it here is a test failure rather than data that quietly survives a purge.
 * `projects` is absent deliberately — the project record itself is transitioned to
 * `DELETED` rather than removed, so the audit trail keeps its subject. `audit_events`
 * is absent for the same reason.
 */
export const PURGEABLE_COLLECTIONS: readonly string[] = [
  'analysis_chunks',
  'analysis_findings',
  'analysis_runs',
  'clarifications',
  'conflict_versions',
  'document_corrections',
  'document_features',
  'document_generation_runs',
  'document_rows',
  'document_sections',
  'document_validation_results',
  'document_versions',
  'documents',
  'estimate_dependencies',
  'estimate_snapshots',
  'estimate_units',
  'estimation_runs',
  'extracted_content',
  'extraction_jobs',
  'requirement_baselines',
  'requirement_items',
  'requirement_sources',
  'requirement_versions',
  'stack_components',
  'stack_recommendation_runs',
  'stack_snapshots',
];

/** Collections a purge must never touch, and why, for the test that asserts it. */
export const PRESERVED_COLLECTIONS: readonly string[] = ['projects', 'audit_events'];
