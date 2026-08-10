import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  EstimateDependencyRecord,
  EstimateSnapshotRecord,
  EstimateUnitRecord,
  EstimationRunRecord,
  type EstimateDependencyDocument,
  type EstimateSnapshotDocument,
  type EstimateUnitDocument,
  type EstimationRunDocument,
} from './schemas/estimation.schema';

/**
 * Every read and write of Phase 6 data.
 *
 * The same two rules as every repository before it.
 *
 * **Every query is scoped by `projectId`** — as a required argument, so the
 * compiler asks the question at each call site. An estimate id alone is one
 * careless call away from reading another project's plan.
 *
 * **Version participates in the filter, never in a prior read.** Check-and-write
 * is one atomic operation, so two tabs overriding the same figure produce one
 * winner and one honest failure rather than a lost update.
 */
@Injectable()
export class EstimationRepository {
  constructor(
    @InjectModel(EstimateSnapshotRecord.name)
    private readonly snapshots: Model<EstimateSnapshotRecord>,
    @InjectModel(EstimateUnitRecord.name)
    private readonly units: Model<EstimateUnitRecord>,
    @InjectModel(EstimateDependencyRecord.name)
    private readonly dependencies: Model<EstimateDependencyRecord>,
    @InjectModel(EstimationRunRecord.name)
    private readonly runs: Model<EstimationRunRecord>,
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

  async createSnapshot(record: Partial<EstimateSnapshotRecord>): Promise<EstimateSnapshotDocument> {
    return this.snapshots.create(record);
  }

  /**
   * The estimate a user is currently working on.
   *
   * Highest version that has not been superseded. A superseded snapshot is
   * history, and handing it back as "current" would mean edits landing in a
   * version somebody already moved on from.
   */
  async currentSnapshot(projectId: string): Promise<EstimateSnapshotDocument | null> {
    return this.snapshots
      .findOne({ projectId, status: { $ne: 'SUPERSEDED' } })
      .sort({ version: -1 })
      .exec();
  }

  async findSnapshot(projectId: string, version: number): Promise<EstimateSnapshotDocument | null> {
    return this.snapshots.findOne({ projectId, version }).exec();
  }

  async listSnapshots(projectId: string, limit = 50): Promise<EstimateSnapshotDocument[]> {
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

  async updateSnapshot(
    projectId: string,
    snapshotId: string,
    expectedVersion: number,
    changes: Partial<EstimateSnapshotRecord>,
    unset: readonly (keyof EstimateSnapshotRecord)[] = [],
  ): Promise<EstimateSnapshotDocument | null> {
    return this.snapshots
      .findOneAndUpdate(
        { projectId, snapshotId, recordVersion: expectedVersion },
        {
          $set: { ...changes, recordVersion: expectedVersion + 1 },
          // Mongoose silently drops `$set: { field: undefined }`, so removing a
          // field genuinely needs `$unset`.
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

  /* ------------------------------------------------------ estimate units */

  async createUnit(record: Partial<EstimateUnitRecord>): Promise<EstimateUnitDocument> {
    return this.units.create(record);
  }

  async insertUnits(records: readonly Partial<EstimateUnitRecord>[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.units.insertMany(records, { ordered: false });
  }

  async listUnits(projectId: string, estimateVersion: number): Promise<EstimateUnitDocument[]> {
    return this.units.find({ projectId, estimateVersion }).sort({ key: 1 }).exec();
  }

  async findUnit(projectId: string, unitId: string): Promise<EstimateUnitDocument | null> {
    return this.units.findOne({ projectId, unitId }).exec();
  }

  async updateUnit(
    projectId: string,
    unitId: string,
    expectedVersion: number,
    changes: Partial<EstimateUnitRecord>,
    unset: readonly (keyof EstimateUnitRecord)[] = [],
  ): Promise<EstimateUnitDocument | null> {
    return this.units
      .findOneAndUpdate(
        { projectId, unitId, recordVersion: expectedVersion },
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
   * Remove the units a re-estimation is allowed to replace.
   *
   * The filter is the whole guard on override authority at the storage layer:
   * a unit a person authored is never in the delete set, so a re-run cannot
   * remove it and write its own in its place.
   */
  async deleteReplaceableUnits(projectId: string, estimateVersion: number): Promise<number> {
    const result = await this.units
      .deleteMany({
        projectId,
        estimateVersion,
        source: { $nin: ['USER_OVERRIDE'] },
      })
      .exec();

    return result.deletedCount ?? 0;
  }

  async countUnits(projectId: string, estimateVersion: number): Promise<number> {
    return this.units.countDocuments({ projectId, estimateVersion }).exec();
  }

  async nextUnitSequence(projectId: string, estimateVersion: number): Promise<number> {
    return (await this.countUnits(projectId, estimateVersion)) + 1;
  }

  /**
   * Copy a version's units forward into a new one.
   *
   * How a superseded estimate keeps saying what it said. The old documents are
   * untouched; the new version gets copies with new ids, and the provenance is
   * carried so a user override stays a user override across a reopen.
   */
  async carryUnitsForward(
    projectId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<Map<string, string>> {
    const existing = await this.listUnits(projectId, fromVersion);
    const idMap = new Map<string, string>();
    const copies: Partial<EstimateUnitRecord>[] = [];

    for (const unit of existing) {
      const unitId = EstimationRepository.newId('est');

      idMap.set(unit.unitId, unitId);
      copies.push({
        unitId,
        projectId,
        estimateVersion: toVersion,
        key: unit.key,
        requirementIds: [...unit.requirementIds],
        module: unit.module,
        submodule: unit.submodule,
        feature: unit.feature,
        taskCategory: unit.taskCategory,
        ...(unit.overheadActivity ? { overheadActivity: unit.overheadActivity } : {}),
        complexity: unit.complexity,
        complexityDrivers: [...unit.complexityDrivers],
        complexityExplanation: unit.complexityExplanation,
        uncertainty: unit.uncertainty,
        uncertaintySources: [...unit.uncertaintySources],
        uncertaintyExplanation: unit.uncertaintyExplanation,
        effort: { ...unit.effort },
        totalHours: unit.totalHours,
        range: { ...unit.range },
        drivers: unit.drivers,
        rationale: unit.rationale,
        source: unit.source,
        ...(unit.originalEffort ? { originalEffort: { ...unit.originalEffort } } : {}),
        ...(unit.originalTotalHours !== undefined
          ? { originalTotalHours: unit.originalTotalHours }
          : {}),
        ...(unit.overrideNote ? { overrideNote: unit.overrideNote } : {}),
        excluded: unit.excluded,
        ...(unit.exclusionReason ? { exclusionReason: unit.exclusionReason } : {}),
      });
    }

    await this.insertUnits(copies);

    return idMap;
  }

  /* -------------------------------------------------------- dependencies */

  async createDependency(
    record: Partial<EstimateDependencyRecord>,
  ): Promise<EstimateDependencyDocument> {
    return this.dependencies.create(record);
  }

  async insertDependencies(records: readonly Partial<EstimateDependencyRecord>[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await this.dependencies.insertMany(records, { ordered: false });
  }

  async listDependencies(
    projectId: string,
    estimateVersion: number,
  ): Promise<EstimateDependencyDocument[]> {
    return this.dependencies.find({ projectId, estimateVersion }).sort({ dependencyId: 1 }).exec();
  }

  async findDependency(
    projectId: string,
    dependencyId: string,
  ): Promise<EstimateDependencyDocument | null> {
    return this.dependencies.findOne({ projectId, dependencyId }).exec();
  }

  async deleteDependency(projectId: string, dependencyId: string): Promise<boolean> {
    const result = await this.dependencies.deleteOne({ projectId, dependencyId }).exec();

    return (result.deletedCount ?? 0) > 0;
  }

  /** As with units, a link a person added is never in the delete set. */
  async deleteReplaceableDependencies(projectId: string, estimateVersion: number): Promise<number> {
    const result = await this.dependencies
      .deleteMany({ projectId, estimateVersion, userDefined: false })
      .exec();

    return result.deletedCount ?? 0;
  }

  async carryDependenciesForward(
    projectId: string,
    fromVersion: number,
    toVersion: number,
    idMap: ReadonlyMap<string, string>,
  ): Promise<void> {
    const existing = await this.listDependencies(projectId, fromVersion);

    await this.insertDependencies(
      existing
        .filter(
          (dependency) => idMap.has(dependency.predecessorId) && idMap.has(dependency.successorId),
        )
        .map((dependency) => ({
          dependencyId: EstimationRepository.newId('dep'),
          projectId,
          estimateVersion: toVersion,
          predecessorId: idMap.get(dependency.predecessorId)!,
          successorId: idMap.get(dependency.successorId)!,
          type: dependency.type,
          reason: dependency.reason,
          lagDays: dependency.lagDays,
          userDefined: dependency.userDefined,
          ...(dependency.note ? { note: dependency.note } : {}),
        })),
    );
  }

  /* ------------------------------------------------------------- runs */

  async createRun(record: Partial<EstimationRunRecord>): Promise<EstimationRunDocument> {
    return this.runs.create(record);
  }

  async latestRun(projectId: string): Promise<EstimationRunDocument | null> {
    return this.runs.findOne({ projectId }).sort({ createdAt: -1 }).exec();
  }

  async activeRun(projectId: string): Promise<EstimationRunDocument | null> {
    return this.runs.findOne({ projectId, status: 'running' }).exec();
  }

  async updateRun(
    projectId: string,
    runId: string,
    changes: Partial<EstimationRunRecord>,
  ): Promise<void> {
    await this.runs.updateOne({ projectId, runId }, { $set: changes }).exec();
  }
}
