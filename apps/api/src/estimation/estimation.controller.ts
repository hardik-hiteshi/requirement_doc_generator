import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  acknowledgeFeasibilitySchema,
  approveEstimateSchema,
  createDependencySchema,
  existingSystemSchema,
  manualEstimateSchema,
  overrideEstimateSchema,
  reopenEstimateSchema,
  startEstimationSchema,
  updateCalendarSchema,
  updateTeamPlanSchema,
  type AcknowledgeFeasibility,
  type ApproveEstimate,
  type CreateDependency,
  type EstimateSnapshot,
  type EstimationRun,
  type ManualEstimate,
  type OverrideEstimate,
  type ReopenEstimate,
  type StartEstimation,
  type UpdateCalendar,
  type UpdateTeamPlan,
} from '@wdrg/contracts';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { EstimationService, type EstimateView, type EstimationContext } from './estimation.service';
import { EstimationAiService } from './estimation-ai.service';
import { EstimationRepository } from './estimation.repository';
import { toRun } from './estimation.mapper';
import { RateLimit } from '../abuse/rate-limit.decorator';

const versionOnlySchema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();

const updateExistingSystemSchema = z
  .object({
    existingSystem: existingSystemSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

type UpdateExistingSystem = z.infer<typeof updateExistingSystemSchema>;

/**
 * The estimate for the project the caller's session is bound to.
 *
 * The project comes from the verified session and never from the request, so
 * every id in a path — an estimate line, a dependency, a version — is scoped by
 * that session. An id belonging to another project resolves to "not found", the
 * same answer as one that never existed.
 *
 * Every mutating route takes an `expectedVersion`. A plan open in two tabs is
 * ordinary, and a lost update here means somebody's override quietly vanishing.
 */
@ApiTags('estimation')
@ApiUnauthorizedResponse({ description: 'No valid project session.' })
@Controller({ path: 'projects/current/estimation' })
@UseGuards(ProjectSessionGuard)
export class EstimationController {
  constructor(
    private readonly estimation: EstimationService,
    private readonly ai: EstimationAiService,
    private readonly repository: EstimationRepository,
  ) {}

  /* --------------------------------------------------------- reading */

  @Get()
  @ApiOperation({ summary: 'The current estimate, with its schedule, capacity and feasibility.' })
  @ApiOkResponse({ description: 'The estimate as it stands.' })
  async current(@Req() request: AuthenticatedRequest): Promise<EstimateView> {
    return this.estimation.current(contextFrom(request));
  }

  @Get('versions')
  @ApiOperation({ summary: 'Every version of the estimate, newest first.' })
  @ApiOkResponse({ description: 'The estimate history.' })
  async versions(@Req() request: AuthenticatedRequest): Promise<{ versions: EstimateSnapshot[] }> {
    return { versions: await this.estimation.listVersions(contextFrom(request)) };
  }

  @Get('versions/:version')
  @ApiOperation({ summary: 'One earlier version, exactly as it stood.' })
  @ApiParam({ name: 'version', description: 'The estimate version number.' })
  @ApiNotFoundResponse({ description: 'No such version in this project.' })
  async version(
    @Req() request: AuthenticatedRequest,
    @Param('version') version: string,
  ): Promise<EstimateSnapshot> {
    return this.estimation.version(contextFrom(request), Number.parseInt(version, 10));
  }

  /* -------------------------------------------------------- estimating */

  @RateLimit('expensive')
  @Post('run')
  @ApiOperation({ summary: 'Estimate the requirements. Works with or without AI.' })
  @ApiCreatedResponse({ description: 'The estimate, with the new lines in it.' })
  async run(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(startEstimationSchema)) body: StartEstimation,
  ): Promise<EstimateView> {
    const context = contextFrom(request);
    const snapshot = await this.estimation.editableSnapshot(context, body.expectedVersion);

    return this.ai.run(context, this.estimation, snapshot, body.useAi);
  }

  @Get('run/current')
  @ApiOperation({ summary: 'The most recent estimation run.' })
  @ApiOkResponse({ description: 'The run, or null if there has never been one.' })
  async currentRun(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ run: EstimationRun | null; configured: boolean }> {
    const context = contextFrom(request);
    const run = await this.repository.latestRun(context.projectId);

    return { run: run ? toRun(run) : null, configured: this.ai.isConfigured };
  }

  @Post('estimates')
  @ApiOperation({ summary: 'Add an estimate line by hand.' })
  @ApiCreatedResponse({ description: 'The estimate, with your line in it.' })
  async addManual(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(manualEstimateSchema)) body: ManualEstimate,
  ): Promise<EstimateView> {
    return this.estimation.addManual(contextFrom(request), body);
  }

  @Patch('estimates/:estimateId')
  @ApiOperation({ summary: 'Change a figure. Your figure is authoritative from then on.' })
  @ApiParam({ name: 'estimateId', description: 'The estimate line in this project.' })
  @ApiOkResponse({ description: 'The estimate, recalculated.' })
  async override(
    @Req() request: AuthenticatedRequest,
    @Param('estimateId') estimateId: string,
    @Body(new ZodValidationPipe(overrideEstimateSchema)) body: OverrideEstimate,
  ): Promise<EstimateView> {
    return this.estimation.override(contextFrom(request), estimateId, body);
  }

  @Post('estimates/:estimateId/reset')
  @ApiOperation({ summary: 'Put a figure back to what the application calculated.' })
  @ApiParam({ name: 'estimateId', description: 'The estimate line in this project.' })
  @ApiCreatedResponse({ description: 'The estimate, recalculated.' })
  async reset(
    @Req() request: AuthenticatedRequest,
    @Param('estimateId') estimateId: string,
    @Body(new ZodValidationPipe(versionOnlySchema)) body: { expectedVersion: number },
  ): Promise<EstimateView> {
    return this.estimation.reset(contextFrom(request), estimateId, body.expectedVersion);
  }

  /* ------------------------------------------------------ dependencies */

  @Post('dependencies')
  @ApiOperation({ summary: 'Say that one thing has to happen before another.' })
  @ApiCreatedResponse({ description: 'The estimate, rescheduled.' })
  async addDependency(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createDependencySchema)) body: CreateDependency,
  ): Promise<EstimateView> {
    return this.estimation.addDependency(contextFrom(request), body);
  }

  @Delete('dependencies/:dependencyId')
  @ApiOperation({ summary: 'Remove a dependency.' })
  @ApiParam({ name: 'dependencyId', description: 'The dependency in this project.' })
  @ApiOkResponse({ description: 'The estimate, rescheduled.' })
  async removeDependency(
    @Req() request: AuthenticatedRequest,
    @Param('dependencyId') dependencyId: string,
    @Body(new ZodValidationPipe(versionOnlySchema)) body: { expectedVersion: number },
  ): Promise<EstimateView> {
    return this.estimation.removeDependency(
      contextFrom(request),
      dependencyId,
      body.expectedVersion,
    );
  }

  /* -------------------------------------------------- calendar and team */

  @Put('calendar')
  @ApiOperation({ summary: 'Which days people work, and how many hours of them are productive.' })
  @ApiOkResponse({ description: 'The estimate, recalculated.' })
  async setCalendar(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateCalendarSchema)) body: UpdateCalendar,
  ): Promise<EstimateView> {
    return this.estimation.setCalendar(contextFrom(request), body.calendar, body.expectedVersion);
  }

  @Put('team')
  @ApiOperation({ summary: 'Who is on the team. Optional — leave it and we recommend one.' })
  @ApiOkResponse({ description: 'The estimate, recalculated.' })
  async setTeam(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateTeamPlanSchema)) body: UpdateTeamPlan,
  ): Promise<EstimateView> {
    return this.estimation.setTeam(contextFrom(request), body.lines, body.expectedVersion);
  }

  @Put('existing-system')
  @ApiOperation({ summary: 'What is known about a codebase this project is changing.' })
  @ApiOkResponse({ description: 'The estimate, recalculated.' })
  async setExistingSystem(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateExistingSystemSchema)) body: UpdateExistingSystem,
  ): Promise<EstimateView> {
    return this.estimation.setExistingSystem(
      contextFrom(request),
      body.existingSystem,
      body.expectedVersion,
    );
  }

  @RateLimit('expensive')
  @Post('schedule/recalculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recalculate the dates only. Effort, complexity and overrides are untouched.',
  })
  @ApiOkResponse({ description: 'The estimate, with new dates and the same hours.' })
  async recalculateSchedule(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(versionOnlySchema)) body: { expectedVersion: number },
  ): Promise<EstimateView> {
    return this.estimation.recalculateSchedule(contextFrom(request), body.expectedVersion);
  }

  /* --------------------------------------------------- risk and approval */

  @Post('risk/acknowledge')
  @ApiOperation({ summary: 'Record that a tight or high-risk timeline was read and accepted.' })
  @ApiCreatedResponse({ description: 'The estimate, with the risk acknowledged.' })
  async acknowledgeRisk(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(acknowledgeFeasibilitySchema)) body: AcknowledgeFeasibility,
  ): Promise<EstimateView> {
    return this.estimation.acknowledgeRisk(contextFrom(request), body);
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve the estimate.' })
  @ApiOkResponse({ description: 'The approved estimate.' })
  async approve(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(approveEstimateSchema)) body: ApproveEstimate,
  ): Promise<EstimateView> {
    return this.estimation.approve(contextFrom(request), body);
  }

  @Post('reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen an approved estimate as a new version.' })
  @ApiOkResponse({ description: 'The new draft version.' })
  async reopen(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(reopenEstimateSchema)) body: ReopenEstimate,
  ): Promise<EstimateView> {
    return this.estimation.reopen(contextFrom(request), body);
  }
}

function contextFrom(request: AuthenticatedRequest): EstimationContext {
  const projectId = request.projectSession?.projectId;

  if (!projectId) {
    // Unreachable: the guard rejects before the handler runs. Throwing rather
    // than defaulting means a future refactor that removes the guard fails
    // loudly instead of quietly serving somebody else's project.
    throw new Error('Session guard did not attach a project.');
  }

  const id = (request as { id?: unknown }).id;

  return { projectId, correlationId: typeof id === 'string' ? id : 'unknown' };
}
