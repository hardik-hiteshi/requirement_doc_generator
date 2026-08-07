import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  acknowledgeRiskSchema,
  approveStackSchema,
  decideRecommendationSchema,
  lockStackSchema,
  selectTechnologySchema,
  stackSelectionModeSchema,
  startRecommendationSchema,
  unlockStackSchema,
  type AcknowledgeRisk,
  type ApproveStack,
  type CategoryApplicabilityEntry,
  type DecideRecommendation,
  type DownstreamAuthority,
  type LockStack,
  type RecommendationRun,
  type SelectTechnology,
  type StackSnapshot,
  type StartRecommendation,
  type UnlockStack,
} from '@wdrg/contracts';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { StackService, type CatalogView, type StackContext, type StackView } from './stack.service';
import { RecommendationService } from './recommendation.service';
import { StackRepository } from './stack.repository';
import { toRecommendationRun } from './stack.mapper';

const versionOnlySchema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();

const setModeSchema = z
  .object({ mode: stackSelectionModeSchema, expectedVersion: z.number().int().nonnegative() })
  .strict();

type SetMode = z.infer<typeof setModeSchema>;

/**
 * The technology stack for the project the caller's session is bound to.
 *
 * The project comes from the verified session and never from the request, so
 * every id in a path — a component, a version — is scoped by that session. An id
 * belonging to another project resolves to "not found", the same answer as one
 * that never existed, so no endpoint here can be used to discover what exists
 * elsewhere.
 *
 * Every mutating route takes an `expectedVersion`. A user with the stack open in
 * two tabs is the normal case, and a lost update here means a technology
 * decision quietly disappearing.
 */
@ApiTags('technology-stack')
@ApiUnauthorizedResponse({ description: 'No valid project session.' })
@Controller({ path: 'projects/current/stack' })
@UseGuards(ProjectSessionGuard)
export class StackController {
  constructor(
    private readonly stack: StackService,
    private readonly recommendations: RecommendationService,
    private readonly repository: StackRepository,
  ) {}

  /* --------------------------------------------------------- reading */

  @Get()
  @ApiOperation({
    summary: 'The current technology stack, with its categories, warnings and blockers.',
  })
  @ApiOkResponse({ description: 'The stack as it stands.' })
  async current(@Req() request: AuthenticatedRequest): Promise<StackView> {
    return this.stack.current(contextFrom(request));
  }

  @Get('versions')
  @ApiOperation({ summary: 'Every version of the stack, newest first.' })
  @ApiOkResponse({ description: 'The stack’s history.' })
  async versions(@Req() request: AuthenticatedRequest): Promise<{ versions: StackSnapshot[] }> {
    return { versions: await this.stack.listVersions(contextFrom(request)) };
  }

  @Get('versions/:version')
  @ApiOperation({ summary: 'One earlier version, exactly as it stood.' })
  @ApiParam({ name: 'version', description: 'The stack version number.' })
  @ApiNotFoundResponse({ description: 'No such version in this project.' })
  async version(
    @Req() request: AuthenticatedRequest,
    @Param('version') version: string,
  ): Promise<StackSnapshot> {
    return this.stack.version(contextFrom(request), Number.parseInt(version, 10));
  }

  @Get('categories')
  @ApiOperation({ summary: 'The technology categories this project has, and why.' })
  @ApiOkResponse({ description: 'The category plan.' })
  async categories(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ categories: readonly CategoryApplicabilityEntry[] }> {
    const view = await this.stack.current(contextFrom(request));

    return { categories: view.snapshot.categoryPlan };
  }

  @Get('catalog')
  @ApiOperation({ summary: 'The reviewed technology catalogue, filtered to this project.' })
  @ApiOkResponse({ description: 'Catalogue entries and the catalogue version.' })
  async catalog(@Req() request: AuthenticatedRequest): Promise<CatalogView> {
    return this.stack.catalog(contextFrom(request));
  }

  /* ------------------------------------------------------------ mode */

  @Put('mode')
  @ApiOperation({ summary: 'Choose how the stack gets filled in.' })
  @ApiOkResponse({ description: 'The stack, with the new mode.' })
  async setMode(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(setModeSchema)) body: SetMode,
  ): Promise<StackView> {
    return this.stack.setMode(contextFrom(request), body.mode, body.expectedVersion);
  }

  /* ------------------------------------------------------ components */

  @Post('components')
  @ApiOperation({ summary: 'Choose a technology for a category.' })
  @ApiCreatedResponse({ description: 'The stack, with your choice in it.' })
  async select(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(selectTechnologySchema)) body: SelectTechnology,
  ): Promise<StackView> {
    return this.stack.select(contextFrom(request), body);
  }

  @Post('components/:componentId/decision')
  @ApiOperation({ summary: 'Accept, reject or replace an AI suggestion.' })
  @ApiParam({ name: 'componentId', description: 'The component in this project.' })
  @ApiCreatedResponse({ description: 'The stack, after your decision.' })
  async decide(
    @Req() request: AuthenticatedRequest,
    @Param('componentId') componentId: string,
    @Body(new ZodValidationPipe(decideRecommendationSchema)) body: DecideRecommendation,
  ): Promise<StackView> {
    return this.stack.decide(contextFrom(request), componentId, body);
  }

  @Post('components/:componentId/lock')
  @ApiOperation({ summary: 'Seal one technology so nothing automatic can change it.' })
  @ApiParam({ name: 'componentId', description: 'The component in this project.' })
  @ApiCreatedResponse({ description: 'The stack, with that component locked.' })
  async lockComponent(
    @Req() request: AuthenticatedRequest,
    @Param('componentId') componentId: string,
    @Body(new ZodValidationPipe(versionOnlySchema)) body: { expectedVersion: number },
  ): Promise<StackView> {
    return this.stack.lockComponent(contextFrom(request), componentId, body.expectedVersion);
  }

  @Post('components/:componentId/unlock')
  @ApiOperation({ summary: 'Unlock one technology. Deliberate, and recorded.' })
  @ApiParam({ name: 'componentId', description: 'The component in this project.' })
  @ApiCreatedResponse({ description: 'The stack, with that component unlocked.' })
  async unlockComponent(
    @Req() request: AuthenticatedRequest,
    @Param('componentId') componentId: string,
    @Body(new ZodValidationPipe(versionOnlySchema)) body: { expectedVersion: number },
  ): Promise<StackView> {
    return this.stack.unlockComponent(contextFrom(request), componentId, body.expectedVersion);
  }

  /* -------------------------------------------------- recommendations */

  @Post('recommendations')
  @ApiOperation({ summary: 'Ask the AI to suggest technologies for the undecided categories.' })
  @ApiCreatedResponse({ description: 'The stack, with suggestions added.' })
  async recommend(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(startRecommendationSchema)) body: StartRecommendation,
  ): Promise<StackView> {
    const context = contextFrom(request);
    // Ensure the snapshot exists and the caller is not stale — the same refusal
    // every other write produces, rather than a second dialect of "out of date".
    const snapshot = await this.stack.editableSnapshot(context, body.expectedVersion);

    return this.recommendations.recommend(context, this.stack, snapshot, body.categories);
  }

  @Get('recommendations/current')
  @ApiOperation({ summary: 'The most recent recommendation run.' })
  @ApiOkResponse({ description: 'The run, or null if there has never been one.' })
  async currentRun(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ run: RecommendationRun | null; configured: boolean }> {
    const context = contextFrom(request);
    const run = await this.repository.latestRun(context.projectId);

    return {
      run: run ? toRecommendationRun(run) : null,
      configured: this.recommendations.isConfigured,
    };
  }

  /* ------------------------------------------------------------ risk */

  @Post('risks/acknowledge')
  @ApiOperation({ summary: 'Record that a warning was read and the choice kept anyway.' })
  @ApiCreatedResponse({ description: 'The stack, with the warning acknowledged.' })
  async acknowledgeRisk(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(acknowledgeRiskSchema)) body: AcknowledgeRisk,
  ): Promise<StackView> {
    return this.stack.acknowledgeRisk(contextFrom(request), body);
  }

  /* -------------------------------------------------- approve and lock */

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve the stack.' })
  @ApiOkResponse({ description: 'The approved stack.' })
  async approve(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(approveStackSchema)) body: ApproveStack,
  ): Promise<StackView> {
    return this.stack.approve(contextFrom(request), body);
  }

  @Post('lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock the stack, making it authoritative for every later phase.' })
  @ApiOkResponse({ description: 'The locked stack.' })
  async lock(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(lockStackSchema)) body: LockStack,
  ): Promise<StackView> {
    return this.stack.lock(contextFrom(request), body);
  }

  @Post('unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reopen a locked stack as a new version.' })
  @ApiOkResponse({ description: 'The new draft version.' })
  async unlock(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(unlockStackSchema)) body: UnlockStack,
  ): Promise<StackView> {
    return this.stack.unlock(contextFrom(request), body);
  }

  @Get('authority')
  @ApiOperation({ summary: 'The contract a locked stack hands to later phases.' })
  @ApiOkResponse({ description: 'The downstream authority contract.' })
  async authority(@Req() request: AuthenticatedRequest): Promise<DownstreamAuthority> {
    return this.stack.authority(contextFrom(request));
  }
}

function contextFrom(request: AuthenticatedRequest): StackContext {
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
