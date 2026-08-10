import { Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  PROJECT_ACCESS_DENIED_MESSAGE,
  PROJECT_NOT_MODIFIABLE_MESSAGE,
  PROJECT_VERSION_CONFLICT_MESSAGE,
  validateDeadlineAgainst,
  validateDeadlineAgainstStart,
  type AuditEventType,
  type OutputPreferences,
  type ProjectDetails,
  type ProjectResponse,
  type StartDate,
  type TeamCapacity,
  type Timeline,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { AppException, ValidationFailedException } from '../common/errors';
import { canRead, canWrite, effectiveStatus, statusAfterEdit } from './domain/project-lifecycle';
import {
  toDetailsMutation,
  toOutputPreferencesMutation,
  toProjectResponse,
  toStartDateMutation,
  toTeamCapacityMutation,
  toTimelineMutation,
} from './mappers/project.mapper';
import { ProjectRepository, type ProjectMutation } from './project.repository';

export interface SectionUpdateContext {
  readonly projectId: string;
  readonly version: number;
  readonly correlationId: string;
}

/**
 * Project reads and section updates.
 *
 * Every write goes through `applyUpdate`, so the ordering of checks — readable,
 * writable, version match — is identical for all five sections. Repeating that
 * per endpoint is how one of them eventually ends up missing a check.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly audit: AuditService,
  ) {}

  async getProject(projectId: string): Promise<ProjectResponse> {
    const now = new Date();
    const record = await this.repository.findByProjectId(projectId);

    if (!record) {
      throw this.accessDenied();
    }

    const decision = canRead(record, now);

    if (!decision.allowed) {
      throw this.accessDenied();
    }

    return toProjectResponse(record, decision.status);
  }

  async updateDetails(
    details: ProjectDetails,
    context: SectionUpdateContext,
  ): Promise<ProjectResponse> {
    return this.applyUpdate(
      context,
      (status) => toDetailsMutation(details, statusAfterEdit(status)),
      'PROJECT_UPDATED',
      { fields: Object.keys(details).filter((key) => details[key as keyof ProjectDetails]) },
    );
  }

  async updateTimeline(
    timeline: Timeline,
    context: SectionUpdateContext,
  ): Promise<ProjectResponse> {
    // Checked here rather than in the schema because "in the past" depends on
    // the current instant, and a schema that reads the clock cannot be tested
    // deterministically.
    const deadline = validateDeadlineAgainst(timeline, new Date());

    if (!deadline.valid) {
      throw new ValidationFailedException([
        { path: 'timeline.deadline', message: deadline.reason, rule: 'invalid_deadline' },
      ]);
    }

    await this.rejectContradictoryDates(context.projectId, { timeline }, 'timeline.deadline');

    return this.applyUpdate(
      context,
      (status) => toTimelineMutation(timeline, statusAfterEdit(status)),
      'TIMELINE_UPDATED',
      { mode: timeline.mode },
    );
  }

  async updateStartDate(
    startDate: StartDate,
    context: SectionUpdateContext,
  ): Promise<ProjectResponse> {
    await this.rejectContradictoryDates(context.projectId, { startDate }, 'startDate.date');

    return this.applyUpdate(
      context,
      (status) => toStartDateMutation(startDate, statusAfterEdit(status)),
      'START_DATE_UPDATED',
      { mode: startDate.mode },
    );
  }

  /**
   * Refuses a delivery deadline that falls before the start date.
   *
   * Either write can create the contradiction, so both consult the value they
   * are not setting. Rejecting here rather than downstream keeps the stored
   * project internally consistent: a negative span makes every schedule,
   * capacity and feasibility figure derived from it meaningless, and the
   * application will not resolve it by moving one of the user's two dates.
   *
   * Only concrete start dates count. A deadline with `NOT_CONFIRMED` is
   * incomplete rather than wrong, and the estimate reports that as missing
   * information instead of refusing the write.
   */
  private async rejectContradictoryDates(
    projectId: string,
    change: { timeline?: Timeline; startDate?: StartDate },
    path: string,
  ): Promise<void> {
    const record = await this.repository.findByProjectId(projectId);

    if (!record) {
      // Left to `applyUpdate`, which owns the access decision.
      return;
    }

    const outcome = validateDeadlineAgainstStart(
      change.timeline ?? (record.timeline as Timeline | undefined),
      change.startDate ?? (record.startDate as StartDate | undefined),
    );

    if (!outcome.valid) {
      throw new ValidationFailedException([
        { path, message: outcome.reason, rule: 'deadline_before_start' },
      ]);
    }
  }

  async updateTeamCapacity(
    capacity: TeamCapacity,
    context: SectionUpdateContext,
  ): Promise<ProjectResponse> {
    return this.applyUpdate(
      context,
      (status) => toTeamCapacityMutation(capacity, statusAfterEdit(status)),
      'TEAM_CAPACITY_UPDATED',
      { customRoleCount: capacity.customRoles?.length ?? 0 },
    );
  }

  async updateOutputPreferences(
    preferences: OutputPreferences,
    context: SectionUpdateContext,
  ): Promise<ProjectResponse> {
    return this.applyUpdate(
      context,
      (status) => toOutputPreferencesMutation(preferences, statusAfterEdit(status)),
      'OUTPUT_PREFERENCES_UPDATED',
      { documents: Object.keys(preferences).length },
    );
  }

  /**
   * Shared write path: verify the project is writable, apply the mutation under
   * an optimistic-concurrency check, then record the audit event.
   */
  private async applyUpdate(
    context: SectionUpdateContext,
    buildMutation: (status: ProjectResponse['status']) => ProjectMutation,
    auditType: AuditEventType,
    auditMetadata?: Record<string, unknown>,
  ): Promise<ProjectResponse> {
    const now = new Date();
    const record = await this.repository.findByProjectId(context.projectId);

    if (!record) {
      throw this.accessDenied();
    }

    const decision = canWrite(record, now);

    if (!decision.allowed) {
      throw new AppException(API_ERROR_CODES.CONFLICT, {
        message: PROJECT_NOT_MODIFIABLE_MESSAGE,
      });
    }

    const updated = await this.repository.updateWithVersion(
      context.projectId,
      context.version,
      buildMutation(decision.status),
    );

    if (!updated) {
      // The filter included the version, so a null result means the project
      // moved on between the client's read and this write.
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
      type: auditType,
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: auditMetadata,
    });

    return toProjectResponse(updated, effectiveStatus(updated, now));
  }

  private accessDenied(): AppException {
    return new AppException(API_ERROR_CODES.UNAUTHORIZED, {
      message: PROJECT_ACCESS_DENIED_MESSAGE,
    });
  }
}
