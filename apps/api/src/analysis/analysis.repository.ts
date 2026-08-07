import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  AnalysisChunkRecord,
  AnalysisFindingRecord,
  AnalysisRunRecord,
  BaselineRecord,
  ClarificationRecord,
  RequirementItemRecord,
  ConflictVersionRecord,
  RequirementVersionRecord,
  type AnalysisChunkDocument,
  type AnalysisFindingDocument,
  type AnalysisRunDocument,
  type BaselineDocument,
  type ClarificationDocument,
  type RequirementItemDocument,
  type ConflictVersionDocument,
  type RequirementVersionDocument,
} from './schemas/analysis.schema';

/**
 * Every read and write of Phase 4 data.
 *
 * The same two rules as Phase 3's repository, for the same reasons.
 *
 * **Every query is scoped by `projectId`.** Every one, as a required argument,
 * so the compiler asks the question at each call site rather than trusting a
 * caller to remember. A requirement id alone is one careless call away from
 * reading another project's baseline.
 *
 * **Version participates in the filter, never in a prior read.** Check-and-write
 * is a single atomic operation, so two reviewers deciding about the same
 * conflict produce one winner and one honest failure rather than a lost update.
 */
@Injectable()
export class AnalysisRepository {
  constructor(
    @InjectModel(AnalysisRunRecord.name)
    private readonly runs: Model<AnalysisRunRecord>,
    @InjectModel(AnalysisChunkRecord.name)
    private readonly chunks: Model<AnalysisChunkRecord>,
    @InjectModel(RequirementItemRecord.name)
    private readonly items: Model<RequirementItemRecord>,
    @InjectModel(AnalysisFindingRecord.name)
    private readonly findings: Model<AnalysisFindingRecord>,
    @InjectModel(ClarificationRecord.name)
    private readonly clarifications: Model<ClarificationRecord>,
    @InjectModel(BaselineRecord.name)
    private readonly baselines: Model<BaselineRecord>,
    @InjectModel(RequirementVersionRecord.name)
    private readonly itemVersions: Model<RequirementVersionRecord>,
    @InjectModel(ConflictVersionRecord.name)
    private readonly conflictVersions: Model<ConflictVersionRecord>,
  ) {}

  /** Crockford base32, matching the ids used everywhere else. */
  static newId(prefix: string): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const bytes = randomBytes(22);
    let id = '';

    for (const byte of bytes) {
      id += alphabet[byte % alphabet.length];
    }

    return `${prefix}_${id}`;
  }

  /* ---------------------------------------------------------------- runs */

  async createRun(record: Partial<AnalysisRunRecord>): Promise<AnalysisRunDocument> {
    return this.runs.create(record);
  }

  async findRun(projectId: string, runId: string): Promise<AnalysisRunDocument | null> {
    return this.runs.findOne({ projectId, runId }).exec();
  }

  async listRuns(projectId: string, limit = 20): Promise<AnalysisRunDocument[]> {
    return this.runs.find({ projectId }).sort({ sequence: -1 }).limit(limit).exec();
  }

  /** The most recent run, whatever its status. */
  async latestRun(projectId: string): Promise<AnalysisRunDocument | null> {
    return this.runs.findOne({ projectId }).sort({ sequence: -1 }).exec();
  }

  /**
   * A run that is still working, if there is one.
   *
   * The guard against two analyses of the same project at once, which would
   * produce two sets of requirement keys and one very confused reviewer.
   */
  async activeRun(projectId: string): Promise<AnalysisRunDocument | null> {
    return this.runs
      .findOne({
        projectId,
        status: { $in: ['PENDING', 'CHUNKING', 'ANALYSING', 'RECONCILING', 'FINALISING'] },
      })
      .exec();
  }

  async nextRunSequence(projectId: string): Promise<number> {
    const latest = await this.runs
      .findOne({ projectId })
      .sort({ sequence: -1 })
      .select({ sequence: 1 })
      .exec();

    return (latest?.sequence ?? 0) + 1;
  }

  async updateRun(
    projectId: string,
    runId: string,
    changes: Partial<AnalysisRunRecord>,
  ): Promise<AnalysisRunDocument | null> {
    return this.runs
      .findOneAndUpdate(
        { projectId, runId },
        { $set: changes, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /** Appends task executions without rewriting the array. */
  async appendExecutions(
    projectId: string,
    runId: string,
    executions: readonly Record<string, unknown>[],
  ): Promise<void> {
    if (executions.length === 0) {
      return;
    }

    await this.runs
      .updateOne({ projectId, runId }, { $push: { executions: { $each: [...executions] } } })
      .exec();
  }

  /** Whether a cancel has been requested. Read between every task. */
  async isCancelled(projectId: string, runId: string): Promise<boolean> {
    const run = await this.runs
      .findOne({ projectId, runId })
      .select({ cancellationRequestedAt: 1, status: 1 })
      .exec();

    return run?.cancellationRequestedAt !== undefined && run.cancellationRequestedAt !== null;
  }

  async supersedeRuns(projectId: string, exceptRunId: string): Promise<void> {
    await this.runs
      .updateMany(
        { projectId, runId: { $ne: exceptRunId }, status: 'COMPLETED' },
        { $set: { status: 'SUPERSEDED' } },
      )
      .exec();
  }

  /* -------------------------------------------------------------- chunks */

  async insertChunks(records: readonly Partial<AnalysisChunkRecord>[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.chunks.insertMany(records);
  }

  async listChunks(projectId: string, runId: string): Promise<AnalysisChunkDocument[]> {
    return this.chunks.find({ projectId, runId }).sort({ index: 1 }).exec();
  }

  async markChunk(
    projectId: string,
    chunkId: string,
    status: string,
    failureReason?: string,
  ): Promise<void> {
    await this.chunks
      .updateOne(
        { projectId, chunkId },
        { $set: { status, ...(failureReason ? { failureReason } : {}) } },
      )
      .exec();
  }

  /* -------------------------------------------------------------- items */

  async insertItems(records: readonly Partial<RequirementItemRecord>[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.items.insertMany(records);
  }

  async listItems(projectId: string, runId?: string): Promise<RequirementItemDocument[]> {
    return this.items
      .find({ projectId, ...(runId ? { runId } : {}) })
      .sort({ key: 1 })
      .exec();
  }

  async findItem(projectId: string, itemId: string): Promise<RequirementItemDocument | null> {
    return this.items.findOne({ projectId, itemId }).exec();
  }

  async findItemsByIds(
    projectId: string,
    itemIds: readonly string[],
  ): Promise<RequirementItemDocument[]> {
    return this.items.find({ projectId, itemId: { $in: [...itemIds] } }).exec();
  }

  /**
   * Updates one item, refusing if it has changed since the caller read it.
   *
   * Returns `null` on a version mismatch. The caller turns that into a 409 that
   * says the item changed elsewhere, rather than silently overwriting whatever
   * the other reviewer did.
   */
  async updateItem(
    projectId: string,
    itemId: string,
    expectedVersion: number,
    changes: Partial<RequirementItemRecord>,
    /**
     * Fields to remove.
     *
     * Separate from `changes` because Mongoose silently drops
     * `$set: { field: undefined }` — clearing a proposal by setting it to
     * undefined leaves it exactly where it was, which is how a rejected
     * proposal came back in the response. `$unset` is the only thing that
     * removes a field.
     */
    unset: readonly (keyof RequirementItemRecord)[] = [],
  ): Promise<RequirementItemDocument | null> {
    return this.items
      .findOneAndUpdate(
        { projectId, itemId, version: expectedVersion },
        {
          $set: changes,
          $inc: { version: 1 },
          ...(unset.length > 0
            ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
            : {}),
        },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /**
   * Records what a requirement said before it was changed.
   *
   * Called by everything that changes one, *before* the change. "The AI rewrote
   * my requirement" has to be answerable with the previous wording in hand.
   */
  async recordVersion(record: Partial<RequirementVersionRecord>): Promise<void> {
    await this.itemVersions.create(record);
  }

  async listVersions(projectId: string, itemId: string): Promise<RequirementVersionDocument[]> {
    return this.itemVersions.find({ projectId, itemId }).sort({ version: -1 }).limit(50).exec();
  }

  /** Items with a proposal outstanding, for the review screen. */
  async listProposals(projectId: string): Promise<RequirementItemDocument[]> {
    return this.items
      .find({ projectId, proposedRevision: { $exists: true, $ne: null } })
      .sort({ key: 1 })
      .exec();
  }

  /** Flags requirements as needing another look, without touching their text. */
  async markForRevalidation(projectId: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) {
      return;
    }

    await this.items
      .updateMany(
        { projectId, itemId: { $in: [...itemIds] } },
        { $set: { needsRevalidation: true } },
      )
      .exec();
  }

  /** Rewrites a computed field without touching the version. */
  async setItemEvidence(
    projectId: string,
    itemId: string,
    evidenceConfidence: Record<string, unknown>,
  ): Promise<void> {
    await this.items.updateOne({ projectId, itemId }, { $set: { evidenceConfidence } }).exec();
  }

  async nextItemSequence(projectId: string): Promise<number> {
    const count = await this.items.countDocuments({ projectId }).exec();

    return count + 1;
  }

  async countItems(projectId: string): Promise<number> {
    return this.items.countDocuments({ projectId }).exec();
  }

  /* ----------------------------------------------------------- findings */

  async insertFindings(records: readonly Partial<AnalysisFindingRecord>[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.findings.insertMany(records);
  }

  async listFindings(
    projectId: string,
    type?: AnalysisFindingRecord['type'],
  ): Promise<AnalysisFindingDocument[]> {
    return this.findings
      .find({ projectId, ...(type ? { type } : {}) })
      .sort({ createdAt: 1 })
      .exec();
  }

  async findFinding(projectId: string, findingId: string): Promise<AnalysisFindingDocument | null> {
    return this.findings.findOne({ projectId, findingId }).exec();
  }

  async updateFinding(
    projectId: string,
    findingId: string,
    expectedVersion: number,
    changes: Partial<AnalysisFindingRecord>,
  ): Promise<AnalysisFindingDocument | null> {
    return this.findings
      .findOneAndUpdate(
        { projectId, findingId, version: expectedVersion },
        { $set: changes, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /**
   * Records a conflict exactly as it was, before anything changes it.
   *
   * Append-only and never updated. An auditor asking "what was conflicting
   * before the clarification?" reads these, so the positions are stored whole
   * rather than referenced.
   */
  async recordConflictVersion(record: Partial<ConflictVersionRecord>): Promise<void> {
    await this.conflictVersions.create(record);
  }

  async listConflictVersions(
    projectId: string,
    conflictId: string,
  ): Promise<ConflictVersionDocument[]> {
    return this.conflictVersions
      .find({ projectId, conflictId })
      .sort({ version: -1 })
      .limit(50)
      .exec();
  }

  /* ------------------------------------------------------ clarifications */

  async insertClarifications(records: readonly Partial<ClarificationRecord>[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.clarifications.insertMany(records);
  }

  async listClarifications(projectId: string): Promise<ClarificationDocument[]> {
    return this.clarifications.find({ projectId }).sort({ key: 1 }).exec();
  }

  async findClarification(
    projectId: string,
    clarificationId: string,
  ): Promise<ClarificationDocument | null> {
    return this.clarifications.findOne({ projectId, clarificationId }).exec();
  }

  async updateClarification(
    projectId: string,
    clarificationId: string,
    expectedVersion: number,
    changes: Partial<ClarificationRecord>,
  ): Promise<ClarificationDocument | null> {
    return this.clarifications
      .findOneAndUpdate(
        { projectId, clarificationId, version: expectedVersion },
        { $set: changes, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async nextClarificationSequence(projectId: string): Promise<number> {
    const count = await this.clarifications.countDocuments({ projectId }).exec();

    return count + 1;
  }

  /* ----------------------------------------------------------- baseline */

  async createBaseline(record: Partial<BaselineRecord>): Promise<BaselineDocument> {
    return this.baselines.create(record);
  }

  /**
   * The baseline a reviewer is working on.
   *
   * The newest version that is not superseded. An approved-then-outdated
   * baseline is still the current one until a new run produces its replacement:
   * the sources having changed does not mean there is suddenly no baseline.
   */
  async currentBaseline(projectId: string): Promise<BaselineDocument | null> {
    return this.baselines
      .findOne({ projectId, status: { $ne: 'superseded' } })
      .sort({ version: -1 })
      .exec();
  }

  async listBaselines(projectId: string): Promise<BaselineDocument[]> {
    return this.baselines.find({ projectId }).sort({ version: -1 }).exec();
  }

  async findBaselineVersion(projectId: string, version: number): Promise<BaselineDocument | null> {
    return this.baselines.findOne({ projectId, version }).exec();
  }

  async nextBaselineVersion(projectId: string): Promise<number> {
    const latest = await this.baselines
      .findOne({ projectId })
      .sort({ version: -1 })
      .select({ version: 1 })
      .exec();

    return (latest?.version ?? 0) + 1;
  }

  async updateBaseline(
    projectId: string,
    baselineId: string,
    expectedVersion: number,
    changes: Partial<BaselineRecord>,
  ): Promise<BaselineDocument | null> {
    return this.baselines
      .findOneAndUpdate(
        { projectId, baselineId, recordVersion: expectedVersion },
        { $set: changes, $inc: { recordVersion: 1 } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /** Rewrites computed fields on a draft. Not permitted once approved. */
  async refreshBaseline(
    projectId: string,
    baselineId: string,
    changes: Partial<BaselineRecord>,
  ): Promise<void> {
    await this.baselines
      .updateOne(
        { projectId, baselineId, status: { $in: ['draft', 'in_review'] } },
        { $set: changes },
      )
      .exec();
  }

  async supersedeBaselines(projectId: string, newVersion: number): Promise<void> {
    await this.baselines
      .updateMany(
        { projectId, version: { $lt: newVersion }, status: { $ne: 'superseded' } },
        { $set: { status: 'superseded', supersededByVersion: newVersion } },
      )
      .exec();
  }

  /**
   * Marks an approved baseline out of date.
   *
   * Deliberately does not touch a single requirement. The baseline still says
   * exactly what it said when it was approved; only the world around it has
   * changed, and this records that.
   */
  async markOutdated(
    projectId: string,
    baselineId: string,
    reason: string,
    at: Date,
  ): Promise<void> {
    await this.baselines
      .updateOne(
        { projectId, baselineId, status: 'approved' },
        { $set: { status: 'outdated', outdatedReason: reason, outdatedAt: at } },
      )
      .exec();
  }

  /** Everything for one project, for deletion. Phase 2's erasure guarantee. */
  async deleteProjectData(projectId: string): Promise<void> {
    await Promise.all([
      this.runs.deleteMany({ projectId }).exec(),
      this.chunks.deleteMany({ projectId }).exec(),
      this.items.deleteMany({ projectId }).exec(),
      this.findings.deleteMany({ projectId }).exec(),
      this.clarifications.deleteMany({ projectId }).exec(),
      this.baselines.deleteMany({ projectId }).exec(),
      this.itemVersions.deleteMany({ projectId }).exec(),
      this.conflictVersions.deleteMany({ projectId }).exec(),
    ]);
  }
}
