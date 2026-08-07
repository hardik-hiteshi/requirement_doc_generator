import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  RecommendationRunRecord,
  StackComponentRecord,
  StackSnapshotRecord,
  type RecommendationRunDocument,
  type StackComponentDocument,
  type StackSnapshotDocument,
} from './schemas/stack.schema';

/**
 * Every read and write of Phase 5 data.
 *
 * The same two rules as Phases 3 and 4, for the same reasons.
 *
 * **Every query is scoped by `projectId`** — as a required argument, so the
 * compiler asks the question at each call site rather than trusting a caller to
 * remember. A component id alone is one careless call away from reading another
 * project's stack.
 *
 * **Version participates in the filter, never in a prior read.** Check-and-write
 * is one atomic operation, so two tabs deciding about the same suggestion
 * produce one winner and one honest failure rather than a lost update.
 */
@Injectable()
export class StackRepository {
  constructor(
    @InjectModel(StackSnapshotRecord.name)
    private readonly snapshots: Model<StackSnapshotRecord>,
    @InjectModel(StackComponentRecord.name)
    private readonly components: Model<StackComponentRecord>,
    @InjectModel(RecommendationRunRecord.name)
    private readonly runs: Model<RecommendationRunRecord>,
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

  /* -------------------------------------------------------- snapshots */

  async createSnapshot(record: Partial<StackSnapshotRecord>): Promise<StackSnapshotDocument> {
    return this.snapshots.create(record);
  }

  /**
   * The stack a user is currently working on.
   *
   * Highest version that has not been superseded. A superseded snapshot is
   * history and must never be handed back as "the current stack" — an edit
   * against it would write into a version somebody already moved on from.
   */
  async currentSnapshot(projectId: string): Promise<StackSnapshotDocument | null> {
    return this.snapshots
      .findOne({ projectId, status: { $ne: 'SUPERSEDED' } })
      .sort({ version: -1 })
      .exec();
  }

  async findSnapshot(projectId: string, version: number): Promise<StackSnapshotDocument | null> {
    return this.snapshots.findOne({ projectId, version }).exec();
  }

  async listSnapshots(projectId: string, limit = 50): Promise<StackSnapshotDocument[]> {
    return this.snapshots.find({ projectId }).sort({ version: -1 }).limit(limit).exec();
  }

  async nextSnapshotVersion(projectId: string): Promise<number> {
    const latest = await this.snapshots
      .findOne({ projectId })
      .sort({ version: -1 })
      .select({ version: 1 })
      .lean()
      .exec();

    return (latest?.version ?? 0) + 1;
  }

  /**
   * Update a snapshot, but only if nobody else has.
   *
   * `recordVersion` is in the filter and incremented in the same operation.
   * Returns null when the row moved, which every caller treats as a conflict
   * rather than retrying blindly.
   */
  async updateSnapshot(
    projectId: string,
    snapshotId: string,
    expectedVersion: number,
    changes: Partial<StackSnapshotRecord>,
    unset: readonly (keyof StackSnapshotRecord)[] = [],
  ): Promise<StackSnapshotDocument | null> {
    return this.snapshots
      .findOneAndUpdate(
        { projectId, snapshotId, recordVersion: expectedVersion },
        {
          $set: { ...changes, recordVersion: expectedVersion + 1 },
          // Mongoose silently drops `$set: { field: undefined }`, so removing a
          // field genuinely needs `$unset` rather than an undefined assignment.
          ...(unset.length > 0
            ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
            : {}),
        },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async supersedeSnapshots(
    projectId: string,
    exceptVersion: number,
    supersededByVersion: number,
  ): Promise<void> {
    await this.snapshots
      .updateMany(
        { projectId, version: { $ne: exceptVersion }, status: { $ne: 'SUPERSEDED' } },
        { $set: { status: 'SUPERSEDED', supersededByVersion } },
      )
      .exec();
  }

  /* -------------------------------------------------------- components */

  async createComponent(record: Partial<StackComponentRecord>): Promise<StackComponentDocument> {
    return this.components.create(record);
  }

  async listComponents(projectId: string, stackVersion: number): Promise<StackComponentDocument[]> {
    return this.components.find({ projectId, stackVersion }).sort({ category: 1 }).exec();
  }

  async findComponent(
    projectId: string,
    componentId: string,
  ): Promise<StackComponentDocument | null> {
    return this.components.findOne({ projectId, componentId }).exec();
  }

  /**
   * Live components in a category.
   *
   * Excludes rejected and superseded ones, which is what makes "is this
   * category filled?" answerable — a category whose only component was rejected
   * is empty, not filled.
   */
  async liveInCategory(
    projectId: string,
    stackVersion: number,
    category: string,
  ): Promise<StackComponentDocument[]> {
    return this.components
      .find({
        projectId,
        stackVersion,
        category,
        status: { $nin: ['REJECTED', 'SUPERSEDED'] },
      })
      .exec();
  }

  async updateComponent(
    projectId: string,
    componentId: string,
    expectedVersion: number,
    changes: Partial<StackComponentRecord>,
    unset: readonly (keyof StackComponentRecord)[] = [],
  ): Promise<StackComponentDocument | null> {
    return this.components
      .findOneAndUpdate(
        { projectId, componentId, recordVersion: expectedVersion },
        {
          $set: { ...changes, recordVersion: expectedVersion + 1 },
          ...(unset.length > 0
            ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
            : {}),
        },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /**
   * Copy a version's components forward into a new one.
   *
   * How a superseded stack keeps saying what it said. The old documents are
   * untouched; the new version gets its own copies with new ids, and the
   * lock state is deliberately *not* carried — a new version of the stack has
   * to be locked on purpose, not by inheritance.
   */
  async carryForward(
    projectId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<StackComponentDocument[]> {
    const existing = await this.listComponents(projectId, fromVersion);
    const copies: StackComponentDocument[] = [];

    for (const component of existing) {
      if (component.status === 'REJECTED' || component.status === 'SUPERSEDED') {
        continue;
      }

      copies.push(
        await this.createComponent({
          componentId: StackRepository.newId('cmp'),
          projectId,
          stackVersion: toVersion,
          category: component.category,
          ...(component.technologyId ? { technologyId: component.technologyId } : {}),
          technologyName: component.technologyName,
          status: component.status === 'LOCKED' ? 'USER_APPROVED' : component.status,
          authority: component.status === 'LOCKED' ? 'USER_APPROVED' : component.authority,
          ...(component.selectionSource ? { selectionSource: component.selectionSource } : {}),
          mandatory: component.mandatory,
          version: component.version,
          evidence: component.evidence,
          evidenceStrength: component.evidenceStrength,
          evidenceContributions: component.evidenceContributions,
          licence: component.licence,
          costPosture: component.costPosture,
          selfHostable: component.selfHostable,
          ...(component.recommendation ? { recommendation: component.recommendation } : {}),
          riskAcknowledgements: component.riskAcknowledgements,
          notes: component.notes,
        }),
      );
    }

    return copies;
  }

  async countComponents(projectId: string, stackVersion: number): Promise<number> {
    return this.components.countDocuments({ projectId, stackVersion }).exec();
  }

  /* ------------------------------------------------- recommendation runs */

  async createRun(record: Partial<RecommendationRunRecord>): Promise<RecommendationRunDocument> {
    return this.runs.create(record);
  }

  async latestRun(projectId: string): Promise<RecommendationRunDocument | null> {
    return this.runs.findOne({ projectId }).sort({ createdAt: -1 }).exec();
  }

  async activeRun(projectId: string): Promise<RecommendationRunDocument | null> {
    return this.runs.findOne({ projectId, status: 'running' }).exec();
  }

  async updateRun(
    projectId: string,
    runId: string,
    changes: Partial<RecommendationRunRecord>,
  ): Promise<void> {
    await this.runs.updateOne({ projectId, runId }, { $set: changes }).exec();
  }
}
