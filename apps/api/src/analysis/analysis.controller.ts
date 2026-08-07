import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
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
  answerClarificationSchema,
  approveBaselineSchema,
  confirmClarificationSchema,
  resolveProposalSchema,
  dismissClarificationSchema,
  manualRequirementSchema,
  requirementItemEditSchema,
  resolveConflictSchema,
  resolveDuplicateSchema,
  resolveFindingSchema,
  startAnalysisSchema,
  type AnalysisRun,
  type AnswerClarification,
  type ApproveBaseline,
  type Baseline,
  type Clarification,
  type DismissClarification,
  type ConfirmClarification,
  type IntegrationResult,
  type ManualRequirement,
  type RequirementItem,
  type ResolveProposal,
  type RequirementItemEdit,
  type ResolveConflict,
  type ResolveDuplicate,
  type ResolveFinding,
  type StartAnalysis,
} from '@wdrg/contracts';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { AnalysisService, type AnalysisContext, type BaselineView } from './analysis.service';

/**
 * Requirement analysis for the project the caller's session is bound to.
 *
 * The project comes from the verified session and never from the request, so
 * every id in a path — a run, a requirement, a conflict — is scoped by that
 * session. An id belonging to another project resolves to "not found", the same
 * answer as one that never existed, so no endpoint here can be used to discover
 * what exists elsewhere.
 *
 * Every mutating route takes an `expectedVersion`. Two people working through a
 * findings list is the normal case, not the exotic one, and a lost update in
 * this phase means a decision somebody made quietly disappearing.
 */
@ApiTags('requirement-analysis')
@ApiUnauthorizedResponse({ description: 'No valid project session.' })
@Controller({ path: 'projects/current/analysis' })
@UseGuards(ProjectSessionGuard)
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  /* --------------------------------------------------------------- runs */

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start an analysis of the reviewed requirement sources' })
  @ApiCreatedResponse({ description: 'The run was accepted and is now working.' })
  async start(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(startAnalysisSchema)) body: StartAnalysis,
  ): Promise<AnalysisRun> {
    return this.analysis.start(contextOf(request), body);
  }

  @Get('runs')
  @ApiOperation({ summary: 'List analysis runs, newest first' })
  @ApiOkResponse({ description: 'Every analysis this project has run.' })
  async listRuns(@Req() request: AuthenticatedRequest): Promise<AnalysisRun[]> {
    return this.analysis.listRuns(contextOf(request));
  }

  @Get('runs/current')
  @ApiOperation({ summary: 'The current or most recent run, with its progress' })
  @ApiOkResponse({ description: 'The run, or null when none has ever been started.' })
  async currentRun(@Req() request: AuthenticatedRequest): Promise<AnalysisRun | null> {
    return this.analysis.currentRun(contextOf(request));
  }

  @Get('runs/:runId')
  @ApiParam({ name: 'runId' })
  @ApiOperation({ summary: 'One run, including every task the model performed' })
  @ApiNotFoundResponse({ description: 'No such run in this project.' })
  async readRun(
    @Req() request: AuthenticatedRequest,
    @Param('runId') runId: string,
  ): Promise<AnalysisRun> {
    return this.analysis.readRun(contextOf(request), runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'runId' })
  @ApiOperation({ summary: 'Ask a running analysis to stop' })
  @ApiOkResponse({ description: 'Cancellation requested. It takes effect between tasks.' })
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('runId') runId: string,
  ): Promise<AnalysisRun> {
    return this.analysis.cancel(contextOf(request), runId);
  }

  /* -------------------------------------------------------- requirements */

  @Get('requirements')
  @ApiOperation({ summary: 'Every requirement in the project' })
  @ApiOkResponse({ description: 'Requirements with their evidence and both confidences.' })
  async listRequirements(@Req() request: AuthenticatedRequest): Promise<RequirementItem[]> {
    return this.analysis.listRequirements(contextOf(request));
  }

  @Post('requirements')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a requirement by hand' })
  @ApiCreatedResponse({ description: 'The requirement, accepted and marked as manual.' })
  async addRequirement(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(manualRequirementSchema)) body: ManualRequirement,
  ): Promise<RequirementItem> {
    return this.analysis.addRequirement(contextOf(request), body);
  }

  @Get('requirements/:itemId')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'One requirement' })
  @ApiNotFoundResponse({ description: 'No such requirement in this project.' })
  async readRequirement(
    @Req() request: AuthenticatedRequest,
    @Param('itemId') itemId: string,
  ): Promise<RequirementItem> {
    return this.analysis.readRequirement(contextOf(request), itemId);
  }

  @Patch('requirements/:itemId')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Edit, accept or reject a requirement' })
  @ApiOkResponse({ description: 'The updated requirement.' })
  async editRequirement(
    @Req() request: AuthenticatedRequest,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(requirementItemEditSchema)) body: RequirementItemEdit,
  ): Promise<RequirementItem> {
    return this.analysis.editRequirement(contextOf(request), itemId, body);
  }

  /* ------------------------------------------------------------ findings */

  @Get('findings')
  @ApiOperation({ summary: 'Duplicates, conflicts, ambiguities and gaps' })
  @ApiOkResponse({ description: 'Every finding, grouped by kind.' })
  async listFindings(@Req() request: AuthenticatedRequest) {
    return this.analysis.listFindings(contextOf(request));
  }

  @Post('findings/duplicates/:groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'groupId' })
  @ApiOperation({ summary: 'Merge a duplicate group, or keep the requirements separate' })
  async resolveDuplicate(
    @Req() request: AuthenticatedRequest,
    @Param('groupId') groupId: string,
    @Body(new ZodValidationPipe(resolveDuplicateSchema)) body: ResolveDuplicate,
  ): Promise<void> {
    await this.analysis.resolveDuplicate(contextOf(request), groupId, body);
  }

  @Post('findings/conflicts/:conflictId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'conflictId' })
  @ApiOperation({ summary: 'Resolve a conflict. No winner is ever chosen automatically' })
  async resolveConflict(
    @Req() request: AuthenticatedRequest,
    @Param('conflictId') conflictId: string,
    @Body(new ZodValidationPipe(resolveConflictSchema)) body: ResolveConflict,
  ): Promise<void> {
    await this.analysis.resolveConflict(contextOf(request), conflictId, body);
  }

  @Get('findings/conflicts/:conflictId/history')
  @ApiParam({ name: 'conflictId' })
  @ApiOperation({ summary: 'What this conflict looked like before each change to it' })
  @ApiOkResponse({ description: 'Snapshots, newest first, with the positions as they were.' })
  async conflictHistory(
    @Req() request: AuthenticatedRequest,
    @Param('conflictId') conflictId: string,
  ) {
    return this.analysis.conflictHistory(contextOf(request), conflictId);
  }

  @Post('findings/ambiguities/:findingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'findingId' })
  @ApiOperation({ summary: 'Settle an ambiguity finding' })
  async resolveAmbiguity(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') findingId: string,
    @Body(new ZodValidationPipe(resolveFindingSchema)) body: ResolveFinding,
  ): Promise<void> {
    await this.analysis.resolveFinding(contextOf(request), findingId, body);
  }

  @Post('findings/gaps/:findingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'findingId' })
  @ApiOperation({ summary: 'Settle a missing-information finding' })
  async resolveGap(
    @Req() request: AuthenticatedRequest,
    @Param('findingId') findingId: string,
    @Body(new ZodValidationPipe(resolveFindingSchema)) body: ResolveFinding,
  ): Promise<void> {
    await this.analysis.resolveFinding(contextOf(request), findingId, body);
  }

  /* ------------------------------------------------------ clarifications */

  @Get('clarifications')
  @ApiOperation({ summary: 'Every clarification question' })
  @ApiOkResponse({ description: 'Questions, with any answers already given.' })
  async listClarifications(@Req() request: AuthenticatedRequest): Promise<Clarification[]> {
    return this.analysis.listClarifications(contextOf(request));
  }

  @Post('clarifications/:clarificationId/answer')
  @ApiParam({ name: 'clarificationId' })
  @ApiOperation({ summary: 'Answer a clarification question' })
  @ApiOkResponse({ description: 'The answered question.' })
  async answerClarification(
    @Req() request: AuthenticatedRequest,
    @Param('clarificationId') clarificationId: string,
    @Body(new ZodValidationPipe(answerClarificationSchema)) body: AnswerClarification,
  ): Promise<Clarification> {
    return this.analysis.answerClarification(contextOf(request), clarificationId, body);
  }

  @Post('clarifications/:clarificationId/confirm')
  @ApiParam({ name: 'clarificationId' })
  @ApiOperation({
    summary: 'Confirm the answer, which folds it into the requirements it affects',
  })
  @ApiOkResponse({ description: 'What the answer changed, and what it proposed.' })
  async confirmClarification(
    @Req() request: AuthenticatedRequest,
    @Param('clarificationId') clarificationId: string,
    @Body(new ZodValidationPipe(confirmClarificationSchema)) body: ConfirmClarification,
  ): Promise<IntegrationResult> {
    return this.analysis.confirmClarification(
      contextOf(request),
      clarificationId,
      body.expectedVersion,
    );
  }

  @Post('clarifications/:clarificationId/dismiss')
  @ApiParam({ name: 'clarificationId' })
  @ApiOperation({ summary: 'Dismiss a question, with a reason' })
  @ApiOkResponse({ description: 'The dismissed question.' })
  async dismissClarification(
    @Req() request: AuthenticatedRequest,
    @Param('clarificationId') clarificationId: string,
    @Body(new ZodValidationPipe(dismissClarificationSchema)) body: DismissClarification,
  ): Promise<Clarification> {
    return this.analysis.dismissClarification(contextOf(request), clarificationId, body);
  }

  /* ----------------------------------------------------------- proposals */

  @Get('proposals')
  @ApiOperation({ summary: 'Requirements with a revision waiting for a decision' })
  @ApiOkResponse({ description: 'Each with its current and proposed wording.' })
  async listProposals(@Req() request: AuthenticatedRequest): Promise<RequirementItem[]> {
    return this.analysis.listProposals(contextOf(request));
  }

  @Post('requirements/:itemId/proposal')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Accept, reject or rewrite a proposed revision' })
  @ApiOkResponse({ description: 'The requirement, with the proposal settled.' })
  async resolveProposal(
    @Req() request: AuthenticatedRequest,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(resolveProposalSchema)) body: ResolveProposal,
  ): Promise<RequirementItem> {
    return this.analysis.resolveProposal(contextOf(request), itemId, body);
  }

  @Get('requirements/:itemId/history')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'What this requirement said before, and why it changed' })
  @ApiOkResponse({ description: 'Versions, newest first.' })
  async requirementHistory(@Req() request: AuthenticatedRequest, @Param('itemId') itemId: string) {
    return this.analysis.requirementHistory(contextOf(request), itemId);
  }

  /* ------------------------------------------------------------ baseline */

  @Get('baseline')
  @ApiOperation({ summary: 'The current baseline, with coverage, alignment and blockers' })
  @ApiOkResponse({ description: 'The baseline and the notice shown alongside it.' })
  @ApiNotFoundResponse({ description: 'No baseline has been produced yet.' })
  async readBaseline(@Req() request: AuthenticatedRequest): Promise<BaselineView> {
    return this.analysis.readBaseline(contextOf(request));
  }

  @Get('baseline/versions')
  @ApiOperation({ summary: 'Every baseline version, newest first' })
  @ApiOkResponse({ description: 'Versions, including approved and superseded ones.' })
  async listVersions(@Req() request: AuthenticatedRequest): Promise<Baseline[]> {
    return this.analysis.listBaselineVersions(contextOf(request));
  }

  @Get('baseline/versions/:version')
  @ApiParam({ name: 'version' })
  @ApiOperation({ summary: 'One baseline version, exactly as it was' })
  async readVersion(
    @Req() request: AuthenticatedRequest,
    @Param('version') version: string,
  ): Promise<Baseline> {
    return this.analysis.readBaselineVersion(contextOf(request), Number(version));
  }

  @Post('baseline/review')
  @ApiOperation({ summary: 'Move the draft baseline into review' })
  @ApiOkResponse({ description: 'The baseline, now in review.' })
  async startReview(@Req() request: AuthenticatedRequest): Promise<Baseline> {
    return this.analysis.startReview(contextOf(request));
  }

  @Post('baseline/approve')
  @ApiOperation({ summary: 'Approve the baseline. Refused while any blocker remains' })
  @ApiOkResponse({ description: 'The approved baseline.' })
  async approve(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(approveBaselineSchema)) body: ApproveBaseline,
  ): Promise<Baseline> {
    return this.analysis.approve(contextOf(request), body);
  }
}

function contextOf(request: AuthenticatedRequest): AnalysisContext {
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
