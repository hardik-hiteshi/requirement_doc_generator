import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ExtractedContent, SourceStatus } from '@wdrg/contracts';
import { Model } from 'mongoose';

import {
  ExtractedContentRecord,
  type ExtractedContentDocument,
} from './schemas/extracted-content.schema';
import {
  RequirementSourceRecord,
  type RequirementSourceDocument,
} from './schemas/requirement-source.schema';

/**
 * Every read and write of a requirement source.
 *
 * Two rules hold throughout, and both are enforced here rather than trusted to
 * callers:
 *
 * **Every query is scoped by `projectId`.** Not "usually" — every one. A method
 * that took only a `sourceId` would be one careless call away from letting a
 * session read another project's source, and the type signature would not
 * complain. Making the project a required argument means the compiler asks the
 * question at every call site.
 *
 * **Version participates in the filter, never in a prior read.** As on the
 * project record, check-and-write is a single atomic operation, so a concurrent
 * save loses loudly instead of silently.
 */
@Injectable()
export class RequirementSourceRepository {
  constructor(
    @InjectModel(RequirementSourceRecord.name)
    private readonly sources: Model<RequirementSourceRecord>,
    @InjectModel(ExtractedContentRecord.name)
    private readonly content: Model<ExtractedContentRecord>,
  ) {}

  /** Crockford base32, matching the project id's alphabet. I, L, O and U out. */
  static newSourceId(): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const bytes = randomBytes(26);
    let id = '';

    for (const byte of bytes) {
      id += alphabet[byte % alphabet.length];
    }

    return `src_${id}`;
  }

  async create(record: Partial<RequirementSourceRecord>): Promise<RequirementSourceDocument> {
    return this.sources.create(record);
  }

  /** A single source, scoped to its project. Excludes deleted ones. */
  async findOne(projectId: string, sourceId: string): Promise<RequirementSourceDocument | null> {
    return this.sources.findOne({ projectId, sourceId, status: { $ne: 'DELETED' } });
  }

  /** Includes deleted sources. For the delete path and for audit lookups. */
  async findAny(projectId: string, sourceId: string): Promise<RequirementSourceDocument | null> {
    return this.sources.findOne({ projectId, sourceId });
  }

  async listForProject(projectId: string): Promise<RequirementSourceDocument[]> {
    return this.sources.find({ projectId, status: { $ne: 'DELETED' } }).sort({ createdAt: 1 });
  }

  /**
   * A live source in this project with the same bytes.
   *
   * Scoped to the project on purpose. A global checksum lookup would answer
   * "does anyone, anywhere, hold this file" — which is an existence oracle
   * across tenants, and exactly the kind of cross-project leak the rest of the
   * design works to prevent.
   */
  async findByChecksum(
    projectId: string,
    checksumSha256: string,
  ): Promise<RequirementSourceDocument | null> {
    return this.sources.findOne({
      projectId,
      checksumSha256,
      status: { $ne: 'DELETED' },
    });
  }

  /** File count and total bytes for a project, against the configured quota. */
  async usage(projectId: string): Promise<{ fileCount: number; totalBytes: number }> {
    const results = await this.sources.aggregate<{ fileCount: number; totalBytes: number }>([
      { $match: { projectId, kind: 'FILE', status: { $ne: 'DELETED' } } },
      { $group: { _id: null, fileCount: { $sum: 1 }, totalBytes: { $sum: '$sizeBytes' } } },
    ]);

    return results[0] ?? { fileCount: 0, totalBytes: 0 };
  }

  /** Optimistic update: the expected version is part of the filter. */
  async updateWithVersion(
    projectId: string,
    sourceId: string,
    expectedVersion: number,
    update: Record<string, unknown>,
    unset?: Record<string, ''>,
  ): Promise<RequirementSourceDocument | null> {
    return this.sources.findOneAndUpdate(
      { projectId, sourceId, version: expectedVersion, status: { $ne: 'DELETED' } },
      {
        $set: update,
        $inc: { version: 1 },
        ...(unset ? { $unset: unset } : {}),
      },
      { new: true },
    );
  }

  /**
   * A status change made by the pipeline, not by a user.
   *
   * No version check, and that is correct: the worker is not racing a user for
   * the same field. Bumping the version on every internal transition would
   * invalidate the version a user's open form is holding, turning routine
   * progress into a spurious "changed elsewhere" conflict.
   */
  async setStatus(
    sourceId: string,
    status: SourceStatus,
    extra: Record<string, unknown> = {},
    unset?: Record<string, ''>,
  ): Promise<RequirementSourceDocument | null> {
    return this.sources.findOneAndUpdate(
      { sourceId },
      { $set: { status, ...extra }, ...(unset ? { $unset: unset } : {}) },
      { new: true },
    );
  }

  async incrementRetry(sourceId: string): Promise<void> {
    await this.sources.updateOne({ sourceId }, { $inc: { retryCount: 1 } });
  }

  async softDelete(projectId: string, sourceId: string): Promise<RequirementSourceDocument | null> {
    return this.sources.findOneAndUpdate(
      { projectId, sourceId, status: { $ne: 'DELETED' } },
      { $set: { status: 'DELETED', deletedAt: new Date() }, $inc: { version: 1 } },
      { new: true },
    );
  }

  /* --------------------------------------------------------------- content */

  /** Appends a revision. Never updates an existing one. */
  async appendRevision(
    projectId: string,
    sourceId: string,
    revision: number,
    origin: 'EXTRACTION' | 'CORRECTION' | 'RESTORE',
    content: ExtractedContent,
    changedBlockIds: string[] = [],
    note?: string,
  ): Promise<ExtractedContentDocument> {
    return this.content.create({
      projectId,
      sourceId,
      revision,
      origin,
      blocks: content.blocks,
      warnings: content.warnings,
      minimumConfidence: content.minimumConfidence,
      ...(content.pageCount !== undefined ? { pageCount: content.pageCount } : {}),
      ...(content.sheetNames ? { sheetNames: content.sheetNames } : {}),
      usedOcr: content.usedOcr,
      extractor: content.extractor,
      changedBlockIds,
      ...(note ? { note } : {}),
    });
  }

  async findRevision(sourceId: string, revision: number): Promise<ExtractedContentDocument | null> {
    return this.content.findOne({ sourceId, revision });
  }

  async listRevisions(sourceId: string): Promise<ExtractedContentDocument[]> {
    return this.content.find({ sourceId }).sort({ revision: 1 });
  }

  /** Removes every revision for a source. Used when a source is re-extracted. */
  async deleteRevisions(sourceId: string): Promise<void> {
    await this.content.deleteMany({ sourceId });
  }

  async deleteProjectContent(projectId: string): Promise<void> {
    await this.content.deleteMany({ projectId });
  }
}
