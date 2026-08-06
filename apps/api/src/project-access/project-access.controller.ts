import { Body, Controller, Delete, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import {
  createProjectRequestSchema,
  exchangeRecoverySecretRequestSchema,
  type CreateProjectRequest,
  type EndSessionResponse,
  type ExchangeRecoverySecretRequest,
  type ProjectCreatedResponse,
  type ProjectSessionResponse,
} from '@wdrg/contracts';
import type { Request, Response } from 'express';

import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { effectiveStatus } from '../projects/domain/project-lifecycle';
import { toProjectResponse } from '../projects/mappers/project.mapper';
import { ProjectAccessService } from './project-access.service';
import { ProjectSessionService } from './project-session.service';

/**
 * Endpoints that establish access. Deliberately unguarded — they are how a
 * caller obtains a session in the first place.
 */
@ApiTags('project-access')
@Controller({ path: 'projects' })
export class ProjectAccessController {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly sessions: ProjectSessionService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an anonymous project',
    description:
      'Creates a project and returns its recovery secret. The secret is shown once and is not recoverable — only a hash of it is stored.',
  })
  @ApiOkResponse({ description: 'Project created; session cookie set.' })
  async create(
    @Body(new ZodValidationPipe(createProjectRequestSchema)) body: CreateProjectRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProjectCreatedResponse> {
    const created = await this.access.createProject(body, correlationId(request));

    // The creator is signed in immediately: requiring them to redeem the link
    // they were just given would be friction with no security benefit.
    this.sessions.issue(response, created.project.projectId);

    return created;
  }

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a recovery secret for a project session',
    description:
      'Verifies the recovery secret and sets an HttpOnly session cookie. Unknown project, wrong secret, expired and deleted all return the same response so projects cannot be enumerated.',
  })
  @ApiUnauthorizedResponse({ description: 'The project could not be opened.' })
  async exchange(
    @Body(new ZodValidationPipe(exchangeRecoverySecretRequestSchema))
    body: ExchangeRecoverySecretRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProjectSessionResponse> {
    const record = await this.access.verifyRecoverySecret(
      body.projectId,
      body.recoverySecret,
      correlationId(request),
    );

    const session = this.sessions.issue(response, record.projectId);

    return {
      project: toProjectResponse(record, effectiveStatus(record, new Date())),
      session: {
        projectId: session.projectId,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  @Delete('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End the current project session',
    description:
      'Clears the session cookies. The project is untouched and can be reopened with the recovery link.',
  })
  async endSession(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EndSessionResponse> {
    const existing = this.sessions.verify(request);

    this.sessions.clear(response);

    if (existing.ok) {
      await this.audit.record({
        type: 'PROJECT_SESSION_ENDED',
        projectId: existing.session.projectId,
        correlationId: correlationId(request),
      });
    }

    return { ended: true };
  }
}

function correlationId(request: Request): string {
  const id = (request as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : 'unknown';
}
