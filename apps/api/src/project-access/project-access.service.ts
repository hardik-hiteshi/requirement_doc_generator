import { Injectable, Logger } from '@nestjs/common';
import {
  buildRecoveryLink,
  PROJECT_ACCESS_DENIED_MESSAGE,
  RECOVERY_WARNING,
  type AccessDeniedReason,
  type ProjectCreatedResponse,
  type CreateProjectRequest,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../common/errors';
import { API_ERROR_CODES } from '@wdrg/contracts';
import { calculateExpiry, effectiveStatus } from '../projects/domain/project-lifecycle';
import {
  toCreateProjectCommand,
  toCreateProjectData,
  toProjectResponse,
} from '../projects/mappers/project.mapper';
import { ProjectRepository, type ProjectRecord } from '../projects/project.repository';
import { ProjectSecretService } from './project-secret.service';

/**
 * Creating and recovering anonymous projects.
 *
 * The security posture in one place: an unguessable id names the project, a
 * separate 256-bit secret authorises it, only a hash of that secret is stored,
 * and every failure to reach a project — unknown, wrong secret, expired, deleted
 * — produces the identical response so the API cannot be used to discover which
 * projects exist.
 */
@Injectable()
export class ProjectAccessService {
  private readonly logger = new Logger(ProjectAccessService.name);

  constructor(
    private readonly repository: ProjectRepository,
    private readonly secrets: ProjectSecretService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Creates a project and returns the recovery secret exactly once.
   *
   * This is the only moment the raw secret exists outside the user's own
   * storage. It is not written to the database, not logged, and cannot be
   * re-derived from the stored hash.
   */
  async createProject(
    request: CreateProjectRequest,
    correlationId: string,
  ): Promise<ProjectCreatedResponse> {
    const command = toCreateProjectCommand(request);
    const now = new Date();

    const projectId = this.secrets.generateProjectId();
    const recoverySecret = this.secrets.generateRecoverySecret();
    const secretHash = await this.secrets.hashSecret(recoverySecret);

    const record = await this.repository.create(
      toCreateProjectData(command, {
        projectId,
        secretHash,
        expiresAt: calculateExpiry(now, this.config.project.expiryDays),
      }),
    );

    await this.audit.record({
      type: 'PROJECT_CREATED',
      projectId,
      correlationId,
      metadata: { hasProjectTypes: Boolean(command.projectTypes?.length) },
    });

    return {
      project: toProjectResponse(record, effectiveStatus(record, now)),
      recoverySecret,
      recoveryLink: buildRecoveryLink(this.config.project.webPublicUrl, projectId, recoverySecret),
      recoveryWarning: RECOVERY_WARNING,
    };
  }

  /**
   * Verifies a recovery secret and returns the project it unlocks.
   *
   * Every rejection path takes the same shape from the caller's point of view.
   * The specific reason is recorded in the audit trail, where an operator can
   * distinguish a mistyped link from a probe and an attacker cannot.
   */
  async verifyRecoverySecret(
    projectId: string,
    recoverySecret: string,
    correlationId: string,
  ): Promise<ProjectRecord> {
    const now = new Date();
    const record = await this.repository.findByProjectId(projectId);

    if (!record) {
      // Still hash a dummy value so a request for an unknown project takes
      // roughly as long as one for a known project with a wrong secret. Without
      // this, response time alone reveals which ids exist.
      await this.secrets.hashSecret(recoverySecret);
      return this.denyRecovery(projectId, 'UNKNOWN_PROJECT', correlationId);
    }

    const storedHash = await this.repository.findSecretHash(projectId);

    if (!storedHash) {
      return this.denyRecovery(projectId, 'UNKNOWN_PROJECT', correlationId);
    }

    const matches = await this.secrets.verifySecret(recoverySecret, storedHash);

    if (!matches) {
      return this.denyRecovery(projectId, 'SECRET_MISMATCH', correlationId);
    }

    const status = effectiveStatus(record, now);

    if (status === 'DELETION_PENDING' || status === 'DELETED') {
      return this.denyRecovery(projectId, 'PROJECT_DELETED', correlationId);
    }

    if (status === 'EXPIRED') {
      // Persist the derived status so the sweep and any reporting agree with
      // what callers are already being told.
      await this.repository.markExpired(projectId);
      return this.denyRecovery(projectId, 'PROJECT_EXPIRED', correlationId);
    }

    await this.repository.touchLastAccessed(projectId, now);

    await this.audit.record({
      type: 'PROJECT_RECOVERED',
      projectId,
      correlationId,
    });

    return record;
  }

  private async denyRecovery(
    projectId: string,
    reason: AccessDeniedReason,
    correlationId: string,
  ): Promise<never> {
    await this.audit.record({
      type: 'PROJECT_RECOVERY_FAILED',
      projectId,
      correlationId,
      reason,
    });

    // Logged at warn with the real reason: operators need it, callers do not.
    this.logger.warn({ projectId, reason, correlationId }, 'Project recovery denied');

    throw new AppException(API_ERROR_CODES.UNAUTHORIZED, {
      message: PROJECT_ACCESS_DENIED_MESSAGE,
    });
  }
}
