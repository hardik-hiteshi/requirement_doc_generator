import { Inject, Injectable, Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import {
  isAbandoned,
  isPurgeEligible,
  METRIC_NAMES,
  PURGEABLE_COLLECTIONS,
  type ProjectStatus,
  type RetentionPolicy,
  type RetentionSweepResult,
} from '@wdrg/contracts';
import type { Connection } from 'mongoose';

import { AuditService } from '../audit/audit.service';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { FILE_STORAGE_PORT, type FileStoragePort } from '../ports';

/**
 * Enforces the retention policy: what stops being kept, and when.
 *
 * Three things happen, in a deliberate order, each of which only ever moves a
 * project one step:
 *
 * 1. A project past its expiry has its **stored status** brought up to date. The
 *    application already treats it as expired — `effectiveStatus` derives that on
 *    every access — but the record said `ACTIVE`, so anyone querying the database
 *    directly saw something the application had long since stopped honouring.
 * 2. A project expired long enough ago to count as abandoned is **queued** for
 *    deletion, entering the same visible pending state a requested deletion does.
 * 3. A project pending deletion past its grace window has its **content purged**
 *    and moves to `DELETED`.
 *
 * Nothing skips a step. An expired project is never purged directly, because the
 * pending state is what makes a deletion observable before it becomes irreversible
 * — and because it gives an operator a window in which to intervene.
 *
 * ## Why this is not a TTL index
 *
 * MongoDB would delete the project document on `expiresAt`, which erases the subject
 * of its own audit trail and skips the pending state entirely. The schema records
 * that decision where the index would otherwise be added.
 *
 * ## What a purge leaves
 *
 * The project record, transitioned to `DELETED`, and its audit trail. Everything
 * else — requirements, analysis, estimates, documents, uploaded files — is removed.
 * A deletion that could not be accounted for afterwards is not a better deletion.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private lastSweep: RetentionSweepResult | undefined;

  constructor(
    @Inject(getConnectionToken()) private readonly connection: Connection,
    @Inject(FILE_STORAGE_PORT) private readonly storage: FileStoragePort,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  /** The most recent sweep in this process, for the operator surface. */
  latestSweep(): RetentionSweepResult | undefined {
    return this.lastSweep;
  }

  /** How many projects are waiting to be purged. Reported, not acted on. */
  async pendingDeletionCount(): Promise<number> {
    return this.projects().countDocuments({ status: 'DELETION_PENDING' });
  }

  /**
   * One pass. Safe to call concurrently with itself only in the sense that it will
   * not corrupt anything — each project is claimed by a conditional update, so two
   * sweeps cannot both purge the same one.
   */
  async sweep(now = new Date()): Promise<RetentionSweepResult> {
    const startedAt = new Date(now);
    const policy = this.config.retention.policy;

    let queuedForDeletion = 0;
    let purged = 0;
    let recordsRemoved = 0;
    let storagePrefixesRemoved = 0;
    let failed = 0;

    /* 1. Stored status catches up with the expiry the domain already derives. */
    const expired = await this.materialiseExpiry(now, policy.batchSize);

    /* 2. Abandoned projects enter the pending state. */
    for (const project of await this.abandonedCandidates(now, policy)) {
      if (!isAbandoned({ status: 'EXPIRED', expiresAt: project.expiresAt, now, policy })) {
        continue;
      }

      try {
        const claimed = await this.transition(project.projectId, 'EXPIRED', 'DELETION_PENDING', {
          deletionRequestedAt: now,
        });

        if (claimed) {
          queuedForDeletion += 1;

          await this.audit.record({
            type: 'PROJECT_QUEUED_FOR_DELETION',
            projectId: project.projectId,
            metadata: {
              reason: 'abandoned_after_expiry',
              expiredGraceDays: policy.expiredGraceDays,
            },
          });
        }
      } catch (error) {
        failed += 1;
        this.logger.error(
          { err: error, projectId: project.projectId },
          'Could not queue a project',
        );
      }
    }

    /* 3. Content goes. */
    for (const project of await this.purgeCandidates(now, policy)) {
      /* The rule is still asked, on the value the query matched. */
      if (
        !isPurgeEligible({
          status: 'DELETION_PENDING',
          deletionRequestedAt: project.deletionRequestedAt,
          now,
          policy,
        })
      ) {
        continue;
      }

      try {
        const result = await this.purge(project.projectId, now);

        if (result) {
          purged += 1;
          recordsRemoved += result.recordsRemoved;
          storagePrefixesRemoved += result.storageRemoved ? 1 : 0;
        }
      } catch (error) {
        failed += 1;
        this.metrics.increment(METRIC_NAMES.retentionFailuresTotal);
        this.logger.error(
          { err: error, projectId: project.projectId },
          'Could not purge a project',
        );
      }
    }

    const result: RetentionSweepResult = {
      expired,
      queuedForDeletion,
      purged,
      recordsRemoved,
      storagePrefixesRemoved,
      failed,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };

    this.lastSweep = result;
    this.metrics.increment(METRIC_NAMES.retentionSweepsTotal, {
      outcome: failed > 0 ? 'partial' : 'ok',
    });
    this.metrics.increment(METRIC_NAMES.retentionProjectsPurgedTotal, {}, purged);
    this.metrics.increment(METRIC_NAMES.retentionRecordsRemovedTotal, {}, recordsRemoved);

    /*
     * A sweep that did nothing is not recorded. The interesting events are the ones
     * that changed something; an hourly "nothing to do" would bury them.
     */
    if (expired + queuedForDeletion + purged + failed > 0) {
      await this.audit.record({
        type: 'RETENTION_SWEEP_COMPLETED',
        projectId: 'system',
        metadata: { ...result },
      });
    }

    return result;
  }

  /**
   * Removes one project's content and moves it to `DELETED`.
   *
   * Order matters. The record is claimed first with a conditional update, so a
   * second sweep cannot start on the same project; then content goes; then storage;
   * and the status is only set to `DELETED` once everything has actually gone. A
   * failure part-way leaves the project `DELETION_PENDING`, which is the state that
   * gets retried — the alternative, marking it deleted first, would abandon files
   * nothing would ever look for again.
   */
  private async purge(
    projectId: string,
    now: Date,
  ): Promise<{ recordsRemoved: number; storageRemoved: boolean } | undefined> {
    let recordsRemoved = 0;

    for (const collection of PURGEABLE_COLLECTIONS) {
      const result = await this.connection.collection(collection).deleteMany({ projectId });

      recordsRemoved += result.deletedCount ?? 0;
    }

    let storageRemoved = false;

    try {
      await this.storage.deleteProject(projectId);
      storageRemoved = true;
    } catch (error) {
      /*
       * Storage failing is reported and does not stop the record moving on: the
       * database content is already gone, so leaving the project pending would retry
       * a purge whose expensive half has been done. The orphaned prefix is logged for
       * an operator, which is a smaller problem than a project stuck in a loop.
       */
      this.logger.warn(
        { err: error, projectId },
        'Project content removed; storage prefix remains',
      );
    }

    const finished = await this.transition(projectId, 'DELETION_PENDING', 'DELETED', {
      deletedAt: now,
    });

    if (!finished) {
      return undefined;
    }

    await this.audit.record({
      type: 'PROJECT_PURGED',
      projectId,
      metadata: { recordsRemoved, storageRemoved },
    });

    return { recordsRemoved, storageRemoved };
  }

  /**
   * Brings stored status in line with expiry.
   *
   * One update for the whole batch: this changes nothing the application was not
   * already doing, so there is no per-project decision to make and no audit event
   * to write. Recording thousands of "this became expired, as it already was"
   * events would be noise in the one place that must stay readable.
   */
  private async materialiseExpiry(now: Date, batchSize: number): Promise<number> {
    const stale = await this.projects()
      .find({ status: { $in: ['DRAFT', 'ACTIVE'] }, expiresAt: { $lte: now } })
      .sort({ expiresAt: 1 })
      .limit(batchSize)
      .project({ projectId: 1 })
      .toArray();

    let updated = 0;

    for (const candidate of stale) {
      const projectId = String(candidate.projectId);

      if (await this.transition(projectId, ['DRAFT', 'ACTIVE'], 'EXPIRED', {})) {
        updated += 1;
      }
    }

    return updated;
  }

  /**
   * Expired projects that have been abandoned long enough to queue, oldest first.
   *
   * The cutoff is in the query rather than applied afterwards, and the order is by the
   * timestamp the decision depends on. Fetching a batch in natural order and filtering
   * it in memory starves the work it is meant to do: with more pending projects than a
   * batch holds, a run keeps re-examining the same ineligible ones at the front of the
   * collection and never reaches the older projects that are actually due. That is
   * silent — the sweep reports having done nothing wrong — and it showed up as a purge
   * that returned zero on a database with other projects in it.
   *
   * `isAbandoned` is still consulted before acting. It is the authority on the rule and
   * is unit-tested as such; this query is an index-friendly way of not reading the whole
   * collection, not a second copy of the decision.
   */
  private async abandonedCandidates(
    now: Date,
    policy: RetentionPolicy,
  ): Promise<{ projectId: string; expiresAt: Date }[]> {
    const cutoff = new Date(now.getTime() - policy.expiredGraceDays * 24 * 60 * 60 * 1000);

    const rows = await this.projects()
      .find({ status: 'EXPIRED', expiresAt: { $lte: cutoff } })
      .sort({ expiresAt: 1 })
      .limit(policy.batchSize)
      .project({ projectId: 1, expiresAt: 1 })
      .toArray();

    return rows.map((row) => ({
      projectId: String(row.projectId),
      expiresAt: row.expiresAt as Date,
    }));
  }

  /**
   * Pending projects past their grace window, oldest request first.
   *
   * `$exists` matters: a pending project with no timestamp predates that field, and
   * `isPurgeEligible` deliberately treats it as not yet due. Leaving it in the batch
   * would let it occupy a slot on every sweep for ever.
   */
  private async purgeCandidates(
    now: Date,
    policy: RetentionPolicy,
  ): Promise<{ projectId: string; deletionRequestedAt: Date }[]> {
    const cutoff = new Date(now.getTime() - policy.deletionGraceDays * 24 * 60 * 60 * 1000);

    const rows = await this.projects()
      .find({
        status: 'DELETION_PENDING',
        deletionRequestedAt: { $exists: true, $lte: cutoff },
      })
      .sort({ deletionRequestedAt: 1 })
      .limit(policy.batchSize)
      .project({ projectId: 1, deletionRequestedAt: 1 })
      .toArray();

    return rows.map((row) => ({
      projectId: String(row.projectId),
      deletionRequestedAt: row.deletionRequestedAt as Date,
    }));
  }

  /**
   * A status change that only lands if the project is still where we found it.
   *
   * The `status` in the filter is what makes a sweep safe to run twice: the second
   * attempt matches nothing rather than repeating the work, and a project a person
   * deleted between the query and the update is not dragged back to a stale state.
   */
  private async transition(
    projectId: string,
    from: ProjectStatus | ProjectStatus[],
    to: ProjectStatus,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.projects().updateOne(
      { projectId, status: Array.isArray(from) ? { $in: from } : from },
      { $set: { status: to, updatedAt: new Date(), ...extra }, $inc: { version: 1 } },
    );

    return result.modifiedCount === 1;
  }

  private projects() {
    return this.connection.collection('projects');
  }
}
