import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  deleteProjectRequestSchema,
  updateOutputPreferencesRequestSchema,
  updateProjectDetailsRequestSchema,
  updateStartDateRequestSchema,
  updateTeamCapacityRequestSchema,
  updateTimelineRequestSchema,
  type DeleteProjectRequest,
  type DeleteProjectResponse,
  type ProjectResponse,
  type UpdateOutputPreferencesRequest,
  type UpdateProjectDetailsRequest,
  type UpdateStartDateRequest,
  type UpdateTeamCapacityRequest,
  type UpdateTimelineRequest,
} from '@wdrg/contracts';
import type { Response } from 'express';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { ProjectSessionService } from '../project-access/project-session.service';
import { ProjectLifecycleService } from './project-lifecycle.service';
import { ProjectsService } from './projects.service';

/**
 * Operations on the project the caller's session is bound to.
 *
 * The project is always taken from the verified session, never from the URL or
 * body. There is therefore no request in which a caller can name a project they
 * have not authenticated for — the class of bug where an id is read from the
 * path and the ownership check is forgotten cannot occur here.
 */
@ApiTags('projects')
@ApiUnauthorizedResponse({ description: 'No valid project session.' })
@Controller({ path: 'projects/current' })
@UseGuards(ProjectSessionGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly lifecycle: ProjectLifecycleService,
    private readonly sessions: ProjectSessionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read the current project' })
  @ApiOkResponse({ description: 'The project the session is bound to.' })
  async current(@Req() request: AuthenticatedRequest): Promise<ProjectResponse> {
    return this.projects.getProject(projectIdOf(request));
  }

  @Put('details')
  @ApiOperation({ summary: 'Update project details' })
  @ApiConflictResponse({ description: 'Version conflict, or the project is no longer editable.' })
  async updateDetails(
    @Body(new ZodValidationPipe(updateProjectDetailsRequestSchema))
    body: UpdateProjectDetailsRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectResponse> {
    return this.projects.updateDetails(body.details, context(request, body.version));
  }

  @Put('timeline')
  @ApiOperation({
    summary: 'Update the delivery timeline',
    description:
      'The timeline is authoritative: it is stored as given and is never silently extended.',
  })
  @ApiConflictResponse({ description: 'Version conflict, or the project is no longer editable.' })
  async updateTimeline(
    @Body(new ZodValidationPipe(updateTimelineRequestSchema)) body: UpdateTimelineRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectResponse> {
    return this.projects.updateTimeline(body.timeline, context(request, body.version));
  }

  @Put('start-date')
  @ApiOperation({
    summary: 'Update the start-date mode',
    description:
      'A date is required only for TENTATIVE_DATE and CONFIRMED_DATE. No date is ever inferred.',
  })
  async updateStartDate(
    @Body(new ZodValidationPipe(updateStartDateRequestSchema)) body: UpdateStartDateRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectResponse> {
    return this.projects.updateStartDate(body.startDate, context(request, body.version));
  }

  @Put('team-capacity')
  @ApiOperation({ summary: 'Update team and capacity inputs' })
  async updateTeamCapacity(
    @Body(new ZodValidationPipe(updateTeamCapacityRequestSchema)) body: UpdateTeamCapacityRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectResponse> {
    return this.projects.updateTeamCapacity(body.teamCapacity, context(request, body.version));
  }

  @Put('output-preferences')
  @ApiOperation({
    summary: 'Update export-format preferences',
    description: 'Formats are validated per document. No files are generated in this phase.',
  })
  async updateOutputPreferences(
    @Body(new ZodValidationPipe(updateOutputPreferencesRequestSchema))
    body: UpdateOutputPreferencesRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectResponse> {
    return this.projects.updateOutputPreferences(
      body.outputPreferences,
      context(request, body.version),
    );
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete the current project',
    description:
      'Requires the project name as confirmation. The session is ended immediately and the project cannot be recovered.',
  })
  async delete(
    @Body(new ZodValidationPipe(deleteProjectRequestSchema)) body: DeleteProjectRequest,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DeleteProjectResponse> {
    const result = await this.lifecycle.deleteProject({
      projectId: projectIdOf(request),
      version: body.version,
      confirmationName: body.confirmationName,
      correlationId: correlationIdOf(request),
    });

    // Cleared here, after the delete succeeds: leaving a cookie pointing at a
    // deleted project would produce a session that fails on every request with
    // no way for the user to tell why.
    this.sessions.clear(response);

    return result;
  }
}

function projectIdOf(request: AuthenticatedRequest): string {
  const projectId = request.projectSession?.projectId;

  if (!projectId) {
    // Unreachable: the guard populates this or throws. Explicit rather than a
    // non-null assertion so a future refactor that drops the guard fails loudly.
    throw new Error('ProjectSessionGuard did not populate the session');
  }

  return projectId;
}

function correlationIdOf(request: AuthenticatedRequest): string {
  const id = (request as { id?: unknown }).id;
  return typeof id === 'string' ? id : 'unknown';
}

function context(request: AuthenticatedRequest, version: number) {
  return {
    projectId: projectIdOf(request),
    version,
    correlationId: correlationIdOf(request),
  };
}
