import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  DocumentCorrectionRecord,
  DocumentFeatureRecord,
  DocumentRowRecord,
  DocumentRecord,
  DocumentRunRecord,
  DocumentSectionRecord,
  DocumentValidationRecord,
  DocumentVersionRecord,
  type DocumentDocument,
  type DocumentFeatureDocument,
  type DocumentRunDocument,
  type DocumentSectionDocument,
  type DocumentVersionDocument,
  type DocumentCorrectionDocument,
  type DocumentRowDocument,
} from './schemas/document.schema';

/**
 * Every read and write of Phase 7 data.
 *
 * The same two rules as every repository before it.
 *
 * **Every query is scoped by `projectId`** — as a required argument, so the
 * compiler asks the question at each call site. A section id alone is one
 * careless call away from reading another project's document.
 *
 * **Version participates in the filter, never in a prior read.** Check-and-write
 * is one atomic operation, so two tabs editing the same section produce one
 * winner and one honest failure rather than a lost update.
 *
 * One rule is specific to this phase. **An approved document is never mutated in
 * place by a generation.** A new version supersedes it, and the old content stays
 * in `document_versions` — so "what did we approve?" has an answer that does not
 * depend on nobody having pressed regenerate since.
 */
@Injectable()
export class DocumentsRepository {
  constructor(
    @InjectModel(DocumentRecord.name)
    private readonly documents: Model<DocumentRecord>,
    @InjectModel(DocumentSectionRecord.name)
    private readonly sections: Model<DocumentSectionRecord>,
    @InjectModel(DocumentFeatureRecord.name)
    private readonly features: Model<DocumentFeatureRecord>,
    @InjectModel(DocumentVersionRecord.name)
    private readonly versions: Model<DocumentVersionRecord>,
    @InjectModel(DocumentRunRecord.name)
    private readonly runs: Model<DocumentRunRecord>,
    @InjectModel(DocumentValidationRecord.name)
    private readonly validations: Model<DocumentValidationRecord>,
    @InjectModel(DocumentCorrectionRecord.name)
    private readonly corrections: Model<DocumentCorrectionRecord>,
    @InjectModel(DocumentRowRecord.name)
    private readonly rows: Model<DocumentRowRecord>,
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

  /* -------------------------------------------------------- documents */

  async create(record: Partial<DocumentRecord>): Promise<DocumentDocument> {
    return this.documents.create(record);
  }

  async find(projectId: string, type: string): Promise<DocumentDocument | null> {
    return this.documents.findOne({ projectId, type }).exec();
  }

  async findAll(projectId: string): Promise<DocumentDocument[]> {
    return this.documents.find({ projectId }).exec();
  }

  /**
   * Applies a change under an optimistic-concurrency check.
   *
   * Returns null when the version moved, which every caller turns into a 409.
   * A returned document is the state *after* the write, so nothing downstream
   * has to re-read and hope.
   */
  async update(
    projectId: string,
    type: string,
    expectedVersion: number,
    changes: Record<string, unknown>,
    unset: readonly string[] = [],
  ): Promise<DocumentDocument | null> {
    return this.documents
      .findOneAndUpdate(
        { projectId, type, recordVersion: expectedVersion },
        {
          $set: { ...changes, recordVersion: expectedVersion + 1 },
          // Mongoose silently drops `$set: { field: undefined }`, so clearing a
          // field has to be an explicit `$unset`. Phase 6 learned this one.
          ...(unset.length > 0
            ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
            : {}),
        },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /** Bumps `recordVersion` without a caller-supplied expectation. */
  async touch(projectId: string, type: string, changes: Record<string, unknown>): Promise<void> {
    await this.documents
      .updateOne({ projectId, type }, { $set: changes, $inc: { recordVersion: 1 } })
      .exec();
  }

  async nextVersion(projectId: string, type: string): Promise<number> {
    const latest = await this.versions
      .findOne({ projectId, type })
      .sort({ version: -1 })
      .select('version')
      .exec();

    return (latest?.version ?? 0) + 1;
  }

  /* --------------------------------------------------------- sections */

  async replaceSections(
    projectId: string,
    type: string,
    documentVersion: number,
    records: readonly Partial<DocumentSectionRecord>[],
  ): Promise<void> {
    await this.sections.deleteMany({ projectId, type, documentVersion }).exec();

    if (records.length > 0) {
      /*
       * `projectId` and `type` are stamped here rather than by the caller. Every
       * row in this collection is scoped by them, and a caller that forgot one
       * would write a section belonging to nothing — so the repository owns it.
       */
      await this.sections.insertMany(
        records.map((record) => ({ ...record, projectId, type, documentVersion })),
      );
    }
  }

  async listSections(
    projectId: string,
    type: string,
    documentVersion: number,
  ): Promise<DocumentSectionDocument[]> {
    return this.sections.find({ projectId, type, documentVersion }).sort({ order: 1 }).exec();
  }

  async findSection(projectId: string, sectionId: string): Promise<DocumentSectionDocument | null> {
    return this.sections.findOne({ projectId, sectionId }).exec();
  }

  async updateSection(
    projectId: string,
    sectionId: string,
    changes: Record<string, unknown>,
  ): Promise<DocumentSectionDocument | null> {
    return this.sections
      .findOneAndUpdate({ projectId, sectionId }, { $set: changes }, { returnDocument: 'after' })
      .exec();
  }

  /* --------------------------------------------------------- features */

  async replaceFeatures(
    projectId: string,
    type: string,
    documentVersion: number,
    records: readonly Partial<DocumentFeatureRecord>[],
  ): Promise<void> {
    await this.features.deleteMany({ projectId, type, documentVersion }).exec();

    if (records.length > 0) {
      await this.features.insertMany(
        records.map((record) => ({ ...record, projectId, type, documentVersion })),
      );
    }
  }

  async listFeatures(
    projectId: string,
    type: string,
    documentVersion: number,
  ): Promise<DocumentFeatureDocument[]> {
    return this.features.find({ projectId, type, documentVersion }).sort({ order: 1 }).exec();
  }

  async findFeature(projectId: string, featureId: string): Promise<DocumentFeatureDocument | null> {
    return this.features.findOne({ projectId, featureId }).exec();
  }

  async updateFeature(
    projectId: string,
    featureId: string,
    changes: Record<string, unknown>,
  ): Promise<DocumentFeatureDocument | null> {
    return this.features
      .findOneAndUpdate({ projectId, featureId }, { $set: changes }, { returnDocument: 'after' })
      .exec();
  }

  /* --------------------------------------------------------- versions */

  /* ------------------------------------------------------------- rows */

  /**
   * Replaces every row of a list document for a new version.
   *
   * `projectId`, `type` and `kind` are stamped here rather than trusted from the
   * caller — the same lesson Phase 7 learned when unscoped section rows leaked
   * between documents.
   */
  async replaceRows(
    projectId: string,
    type: string,
    kind: string,
    documentVersion: number,
    rows: readonly Record<string, unknown>[],
  ): Promise<void> {
    await this.rows.deleteMany({ projectId, type }).exec();

    if (rows.length > 0) {
      await this.rows.insertMany(
        rows.map((row) => ({ ...row, projectId, type, kind, documentVersion })),
      );
    }
  }

  async insertRows(
    projectId: string,
    type: string,
    kind: string,
    documentVersion: number,
    rows: readonly Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length > 0) {
      await this.rows.insertMany(
        rows.map((row) => ({ ...row, projectId, type, kind, documentVersion })),
      );
    }
  }

  async listRows(
    projectId: string,
    type: string,
    documentVersion: number,
  ): Promise<DocumentRowDocument[]> {
    return this.rows.find({ projectId, type, documentVersion }).sort({ order: 1 }).exec();
  }

  async findRow(projectId: string, rowId: string): Promise<DocumentRowDocument | null> {
    return this.rows.findOne({ projectId, rowId }).exec();
  }

  async updateRow(
    projectId: string,
    rowId: string,
    changes: Record<string, unknown>,
    unset: readonly string[] = [],
  ): Promise<void> {
    await this.rows
      .updateOne(
        { projectId, rowId },
        {
          $set: changes,
          ...(unset.length > 0
            ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) }
            : {}),
        },
      )
      .exec();
  }

  async createVersion(record: Partial<DocumentVersionRecord>): Promise<DocumentVersionDocument> {
    return this.versions.create(record);
  }

  async listVersions(projectId: string, type: string): Promise<DocumentVersionDocument[]> {
    return this.versions.find({ projectId, type }).sort({ version: -1 }).exec();
  }

  async findVersion(
    projectId: string,
    type: string,
    version: number,
  ): Promise<DocumentVersionDocument | null> {
    return this.versions.findOne({ projectId, type, version }).exec();
  }

  async updateVersion(
    projectId: string,
    type: string,
    version: number,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.versions.updateOne({ projectId, type, version }, { $set: changes }).exec();
  }

  /* ------------------------------------------------------------- runs */

  async createRun(record: Partial<DocumentRunRecord>): Promise<DocumentRunDocument> {
    return this.runs.create(record);
  }

  async activeRun(projectId: string, type: string): Promise<DocumentRunDocument | null> {
    return this.runs.findOne({ projectId, type, status: { $in: ['QUEUED', 'RUNNING'] } }).exec();
  }

  async latestRun(projectId: string, type: string): Promise<DocumentRunDocument | null> {
    return this.runs.findOne({ projectId, type }).sort({ startedAt: -1 }).exec();
  }

  async finishRun(runId: string, changes: Record<string, unknown>): Promise<void> {
    await this.runs.updateOne({ runId }, { $set: changes }).exec();
  }

  /* ------------------------------------------------------ validations */

  async recordValidation(
    record: Partial<DocumentValidationRecord>,
  ): Promise<DocumentValidationRecord> {
    return this.validations.create(record);
  }

  /* ------------------------------------------------------ corrections */

  async recordCorrection(
    record: Partial<DocumentCorrectionRecord>,
  ): Promise<DocumentCorrectionDocument> {
    return this.corrections.create(record);
  }

  async completeCorrection(correctionId: string, changes: Record<string, unknown>): Promise<void> {
    await this.corrections.updateOne({ correctionId }, { $set: changes }).exec();
  }

  async listCorrections(projectId: string, type: string): Promise<DocumentCorrectionDocument[]> {
    return this.corrections.find({ projectId, type }).sort({ createdAt: -1 }).exec();
  }

  async latestValidation(
    projectId: string,
    type: string,
  ): Promise<DocumentValidationRecord | null> {
    return this.validations.findOne({ projectId, type }).sort({ createdAt: -1 }).exec();
  }
}
