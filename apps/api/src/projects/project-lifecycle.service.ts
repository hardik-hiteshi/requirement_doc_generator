import { Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  PROJECT_ACCESS_DENIED_MESSAGE,
  PROJECT_VERSION_CONFLICT_MESSAGE,
  type DeleteProjectResponse,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { AppException, ValidationFailedException } from '../common/errors';
import { canWrite } from './domain/project-lifecycle';
import { ProjectRepository } from './project.repository';

export interface DeleteProjectContext {
  readonly projectId: string;
  readonly version: number;
  readonly confirmationName: string;
  readonly correlationId: string;
}

/**
 * Deletion.
 *
 * Kept apart from the section-update service because the rules differ in kind:
 * deletion is confirmed by typed name, is irreversible for the user, and ends
 * the session as a side effect. Folding it into the general write path would
 * mean special-casing all three.
 */
@Injectable()
export class ProjectLifecycleService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Soft-deletes a project after confirming the typed name matches.
   *
   * There is no undo and no support channel that can restore it, so the
   * confirmation is a real gate rather than a formality. The comparison is
   * whitespace- and case-insensitive: the user is proving intent, not spelling.
   */
  async deleteProject(context: DeleteProjectContext): Promise<DeleteProjectResponse> {
    const now = new Date();
    const record = await this.repository.findByProjectId(context.projectId);

    if (!record) {
      throw new AppException(API_ERROR_CODES.UNAUTHORIZED, {
        message: PROJECT_ACCESS_DENIED_MESSAGE,
      });
    }

    const decision = canWrite(record, now);

    if (!decision.allowed && decision.reason === 'DELETED') {
      // Already gone. Reported as success so a retried request — a double click,
      // a resent form — does not surface an error for an outcome the caller
      // already has.
      await this.audit.record({
        type: 'PROJECT_DELETED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { alreadyDeleted: true },
      });

      return {
        projectId: record.projectId,
        status: record.status,
        deletedAt: (record.deletionRequestedAt ?? record.updatedAt).toISOString(),
      };
    }

    if (normalize(context.confirmationName) !== normalize(record.name)) {
      throw new ValidationFailedException([
        {
          path: 'confirmationName',
          message: 'Type the project name exactly to confirm deletion.',
          rule: 'confirmation_mismatch',
        },
      ]);
    }

    await this.audit.record({
      type: 'PROJECT_DELETION_REQUESTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
    });

    const deleted = await this.repository.softDelete(context.projectId, context.version);

    if (!deleted) {
      throw new AppException(API_ERROR_CODES.CONFLICT, {
        message: PROJECT_VERSION_CONFLICT_MESSAGE,
        details: [
          {
            path: 'version',
            message: `Expected version ${context.version}, but the project has since changed.`,
            rule: 'version_conflict',
          },
        ],
      });
    }

    await this.audit.record({
      type: 'PROJECT_DELETED',
      projectId: context.projectId,
      correlationId: context.correlationId,
    });

    return {
      projectId: deleted.projectId,
      status: deleted.status,
      deletedAt: (deleted.deletionRequestedAt ?? new Date()).toISOString(),
    };
  }
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
