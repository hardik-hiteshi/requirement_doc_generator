import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ProjectStatus } from '@wdrg/contracts';
import { Model } from 'mongoose';

import type { StoredSecretHash } from '../project-access/project-secret.service';
import { Project, PROJECT_SCHEMA_VERSION, type ProjectDocument } from './schemas/project.schema';

/**
 * A project as the domain sees it.
 *
 * Deliberately not a Mongoose document: services receive plain data, so nothing
 * outside this file can call `.save()`, mutate a live document, or accidentally
 * serialise `_id` into a response.
 */
export interface ProjectRecord {
  readonly projectId: string;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly name: string;
  readonly clientName?: string;
  readonly internalReference?: string;
  readonly description?: string;
  readonly projectTypes?: readonly string[];
  readonly timeline?: Record<string, unknown>;
  readonly startDate?: Record<string, unknown>;
  readonly teamCapacity?: Record<string, unknown>;
  readonly outputPreferences?: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastAccessedAt: Date;
  readonly expiresAt: Date;
  readonly deletionRequestedAt?: Date;
  readonly deletedAt?: Date;
}

export interface CreateProjectData {
  readonly projectId: string;
  readonly secretHash: StoredSecretHash;
  readonly name: string;
  readonly clientName?: string;
  readonly internalReference?: string;
  readonly description?: string;
  readonly projectTypes?: readonly string[];
  readonly expiresAt: Date;
}

/** Fields a section update may set. Nothing else is writable through here. */
export interface ProjectMutation {
  readonly name?: string;
  readonly clientName?: string;
  readonly internalReference?: string;
  readonly description?: string;
  readonly projectTypes?: readonly string[];
  readonly timeline?: Record<string, unknown>;
  readonly startDate?: Record<string, unknown>;
  readonly teamCapacity?: Record<string, unknown>;
  readonly outputPreferences?: Record<string, unknown>;
  readonly status?: ProjectStatus;
}

/**
 * The only place in the application that talks to the Mongoose model.
 *
 * Everything above this layer works with `ProjectRecord`, which keeps the domain
 * free of persistence types and makes swapping the store a change confined to
 * this file.
 */
@Injectable()
export class ProjectRepository {
  constructor(@InjectModel(Project.name) private readonly model: Model<ProjectDocument>) {}

  async create(data: CreateProjectData): Promise<ProjectRecord> {
    const now = new Date();

    const created = await this.model.create({
      projectId: data.projectId,
      secretHash: data.secretHash,
      status: 'DRAFT' satisfies ProjectStatus,
      version: 0,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: data.name,
      clientName: data.clientName,
      internalReference: data.internalReference,
      description: data.description,
      projectTypes: data.projectTypes ? [...data.projectTypes] : undefined,
      lastAccessedAt: now,
      expiresAt: data.expiresAt,
    });

    return toRecord(created);
  }

  async findByProjectId(projectId: string): Promise<ProjectRecord | null> {
    const found = await this.model.findOne({ projectId }).lean().exec();
    return found ? toRecord(found) : null;
  }

  /**
   * Loads the stored hash for a verification attempt.
   *
   * `secretHash` is excluded from the schema by default (`select: false`), so it
   * only ever reaches memory through this one method — a query written anywhere
   * else cannot pull it in by accident.
   */
  async findSecretHash(projectId: string): Promise<StoredSecretHash | null> {
    const found = await this.model.findOne({ projectId }).select('+secretHash').lean().exec();

    if (!found?.secretHash) {
      return null;
    }

    const { algorithm, version, salt, hash } = found.secretHash;
    return { algorithm, version, salt, hash } as StoredSecretHash;
  }

  /**
   * Applies a mutation only if the caller's version is still current.
   *
   * The version is part of the query filter, so the check and the write are one
   * atomic operation. Reading, comparing in application code, then writing would
   * leave a window in which a concurrent save is silently overwritten.
   *
   * @returns the updated record, or `null` when the version no longer matches.
   */
  async updateWithVersion(
    projectId: string,
    expectedVersion: number,
    mutation: ProjectMutation,
  ): Promise<ProjectRecord | null> {
    const $set: Record<string, unknown> = { lastAccessedAt: new Date() };
    const $unset: Record<string, 1> = {};

    for (const [key, value] of Object.entries(mutation)) {
      if (value === undefined) {
        // An explicit `undefined` from a mapper means "clear this field", which
        // in Mongo is $unset rather than setting null.
        $unset[key] = 1;
      } else {
        $set[key] = value;
      }
    }

    const updated = await this.model
      .findOneAndUpdate(
        { projectId, version: expectedVersion },
        {
          $set,
          ...(Object.keys($unset).length > 0 ? { $unset } : {}),
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();

    return updated ? toRecord(updated) : null;
  }

  /** Records that the project was read, without touching `version`. */
  async touchLastAccessed(projectId: string, at: Date): Promise<void> {
    await this.model.updateOne({ projectId }, { $set: { lastAccessedAt: at } }).exec();
  }

  /**
   * Marks a project deleted.
   *
   * A soft delete: the record survives so the audit trail keeps its subject, and
   * so a second delete of the same project is idempotent rather than a confusing
   * "not found". Physical removal is the retention job's decision in Phase 12.
   */
  async softDelete(projectId: string, expectedVersion: number): Promise<ProjectRecord | null> {
    const now = new Date();

    const updated = await this.model
      .findOneAndUpdate(
        { projectId, version: expectedVersion },
        {
          $set: {
            status: 'DELETION_PENDING' satisfies ProjectStatus,
            deletionRequestedAt: now,
            lastAccessedAt: now,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();

    return updated ? toRecord(updated) : null;
  }

  /** Moves a project to the expired state. Used lazily on access. */
  async markExpired(projectId: string): Promise<void> {
    await this.model
      .updateOne(
        { projectId, status: { $in: ['DRAFT', 'ACTIVE'] } },
        { $set: { status: 'EXPIRED' satisfies ProjectStatus } },
      )
      .exec();
  }
}

type LeanProject = Omit<Project, 'secretHash'> & Partial<Pick<Project, 'secretHash'>>;

/**
 * Maps a persisted document to the domain record.
 *
 * Written as an explicit field list rather than a spread: a spread would carry
 * `_id`, `secretHash` and anything a future schema change adds straight into the
 * domain, and from there into a response. Naming each field means a new
 * persisted field is invisible until someone deliberately exposes it.
 */
function toRecord(document: LeanProject): ProjectRecord {
  return {
    projectId: document.projectId,
    status: document.status,
    version: document.version,
    name: document.name,
    clientName: document.clientName,
    internalReference: document.internalReference,
    description: document.description,
    projectTypes: document.projectTypes,
    timeline: document.timeline,
    startDate: document.startDate,
    teamCapacity: document.teamCapacity,
    outputPreferences: document.outputPreferences,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastAccessedAt: document.lastAccessedAt,
    expiresAt: document.expiresAt,
    deletionRequestedAt: document.deletionRequestedAt,
    deletedAt: document.deletedAt,
  };
}
