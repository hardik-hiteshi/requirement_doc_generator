import { Inject, Injectable } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import {
  FORBIDDEN_PROJECT_VIEW_FIELDS,
  type AdminProjectDetail,
  type AdminProjectList,
  type AdminProjectQuery,
  type AdminProjectSummary,
  type ProjectStatus,
} from '@wdrg/contracts';
import type { Connection } from 'mongoose';

import { effectiveStatus } from '../projects/domain/project-lifecycle';

/**
 * What an operator can learn about a project without reading it.
 *
 * The whole design of this service is the projection: a fixed list of fields, built
 * one at a time from a document that has many more. Nothing is spread, nothing is
 * passed through, and `_id` never leaves. That is deliberate — a projection written
 * as `{ ...record, secretHash: undefined }` is one refactor away from carrying
 * everything, and the thing it would carry is a client's commercial documents.
 *
 * ## Why counts rather than content
 *
 * The support questions this exists for are about shape. "Their upload never
 * finished" is answered by an extraction job sitting in `queued`. "They can't edit"
 * is answered by the difference between the stored status and the derived one. "Did
 * anything generate" is answered by a document count. None of them require reading a
 * requirement, and an operator surface that could read one would be read from.
 */
@Injectable()
export class AdminProjectsService {
  constructor(@Inject(getConnectionToken()) private readonly connection: Connection) {}

  async list(query: AdminProjectQuery): Promise<AdminProjectList> {
    const filter: Record<string, unknown> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.projectId) {
      filter.projectId = query.projectId;
    }

    /* One more than asked for, so truncation is detected rather than guessed. */
    const rows = await this.projects()
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(query.limit + 1)
      .project(SUMMARY_PROJECTION)
      .toArray();

    return {
      projects: rows.slice(0, query.limit).map((row) => this.toSummary(row)),
      truncated: rows.length > query.limit,
    };
  }

  /** One project, with counts. `undefined` when there is no such project. */
  async detail(projectId: string): Promise<AdminProjectDetail | undefined> {
    const row = await this.projects().findOne({ projectId }, { projection: SUMMARY_PROJECTION });

    if (!row) {
      return undefined;
    }

    const [
      requirementSources,
      requirementItems,
      documents,
      documentVersions,
      extractionJobs,
      auditEvents,
    ] = await Promise.all([
      this.count('requirement_sources', projectId),
      this.count('requirement_items', projectId),
      this.count('documents', projectId),
      this.count('document_versions', projectId),
      this.count('extraction_jobs', projectId),
      this.count('audit_events', projectId),
    ]);

    /*
     * Unfinished jobs, by state. `completed` and `cancelled` are excluded because a
     * finished job answers no operational question — what an operator needs to see is
     * what is still outstanding.
     */
    const unfinished = await this.connection
      .collection('extraction_jobs')
      .aggregate<{ _id: string; count: number }>([
        { $match: { projectId, status: { $in: ['queued', 'running', 'failed', 'dead_letter'] } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();

    return {
      ...this.toSummary(row),
      counts: {
        requirementSources,
        requirementItems,
        documents,
        documentVersions,
        extractionJobs,
        auditEvents,
      },
      unfinishedJobs: Object.fromEntries(unfinished.map((entry) => [entry._id, entry.count])),
    };
  }

  /**
   * Builds the summary field by field.
   *
   * Long-hand on purpose. Every line here is a decision that this field is safe to
   * show an operator, and the test that asserts no forbidden field appears in a
   * response is checking this function's output.
   */
  private toSummary(row: Record<string, unknown>): AdminProjectSummary {
    const status = String(row.status) as ProjectStatus;
    const expiresAt = row.expiresAt as Date;

    const derived = effectiveStatus({ status, expiresAt } as never, new Date());

    return {
      projectId: String(row.projectId),
      name: typeof row.name === 'string' ? row.name : '',
      status,
      effectiveStatus: derived,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
      ...(row.lastAccessedAt ? { lastAccessedAt: this.iso(row.lastAccessedAt) } : {}),
      expiresAt: this.iso(expiresAt),
      ...(row.deletionRequestedAt
        ? { deletionRequestedAt: this.iso(row.deletionRequestedAt) }
        : {}),
    };
  }

  private iso(value: unknown): string {
    return (value instanceof Date ? value : new Date()).toISOString();
  }

  private async count(collection: string, projectId: string): Promise<number> {
    return this.connection.collection(collection).countDocuments({ projectId });
  }

  private projects() {
    return this.connection.collection('projects');
  }
}

/**
 * The only fields read from the database.
 *
 * Restricting at the query rather than after it means the secret hash and every
 * content field are never in this process's memory to begin with — a stronger
 * guarantee than filtering them out afterwards, and the reason
 * `FORBIDDEN_PROJECT_VIEW_FIELDS` is a test's assertion rather than this code's
 * filter.
 */
const SUMMARY_PROJECTION = {
  _id: 0,
  projectId: 1,
  name: 1,
  status: 1,
  createdAt: 1,
  updatedAt: 1,
  lastAccessedAt: 1,
  expiresAt: 1,
  deletionRequestedAt: 1,
} as const;

/* Referenced so the contract's list cannot drift out of use unnoticed. */
export const FORBIDDEN_FIELDS_FOR_TESTS = FORBIDDEN_PROJECT_VIEW_FIELDS;
