import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  addRowSchema,
  confirmAssumptionSchema,
  editRowSchema,
  excludeRowSchema,
  regenerateRowGroupSchema,
  regenerateRowSchema,
  rejectAssumptionSchema,
  removeRowSchema,
  resolveRowProposalSchema,
  receiveDependencySchema,
  requestDependencySchema,
  settleAssumptionSchema,
  validateDependencySchema,
  type AddRow,
  type ConfirmAssumption,
  type DocumentRow,
  type EditRow,
  type ExcludeRow,
  type RegenerateRow,
  type RegenerateRowGroup,
  type RejectAssumption,
  type RemoveRow,
  type ResolveRowProposal,
  type ReceiveDependency,
  type RequestDependency,
  type SettleAssumption,
  type ValidateDependency,
  acknowledgeFindingSchema,
  applyCorrectionSchema,
  approveDocumentSchema,
  attemptsEffortEdit,
  DOCUMENT_ERROR_CODES,
  DOCUMENT_TYPES,
  documentTypeSchema,
  generateDocumentSchema,
  markFinalSchema,
  regenerateSectionSchema,
  reopenDocumentSchema,
  resolveFeatureProposalSchema,
  resolveSectionProposalSchema,
  restoreVersionSchema,
  updateFeatureRowSchema,
  updateSectionSchema,
  type AcknowledgeFinding,
  type ApplyCorrection,
  type ApproveDocument,
  type CorrectionInstruction,
  type DocumentDiff,
  type DocumentRun,
  type DocumentSnapshot,
  type DocumentSummary,
  type DocumentType,
  type ArtifactTrace,
  type DocumentVersionSummary,
  type TraceabilityView,
  type FeatureRow,
  type GenerateDocument,
  type MarkFinal,
  type RegenerateSection,
  type ReopenDocument,
  type ResolveFeatureProposal,
  type ResolveSectionProposal,
  type RestoreVersion,
  type UpdateSection,
  EXPORT_FORMATS,
  brandingSchema,
  type Branding,
  type ProjectDocument,
} from '@wdrg/contracts';
import { z } from 'zod';

import type { Response } from 'express';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { DocumentError } from './documents.errors';
import { DocumentsAiService } from './documents-ai.service';
import { DocumentExportService } from './export/document-export.service';
import { ProjectRepository } from '../projects/project.repository';
import { FILE_STORAGE_PORT, type FileStoragePort } from '../ports';
import { DocumentsRepository } from './documents.repository';
import { TraceabilityService } from './traceability.service';
import { DocumentsService, type DocumentContext } from './documents.service';
import { toDocumentRun } from './documents.mapper';

const excludeRequirementSchema = z
  .object({
    requirementId: z.string().min(1).max(64),
    reason: z.string().min(1).max(500),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

type ExcludeRequirement = z.infer<typeof excludeRequirementSchema>;

const regenerateModuleSchema = z
  .object({
    module: z.string().min(1).max(200),
    instruction: z.string().max(2_000).optional(),
    useAi: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

type RegenerateModule = z.infer<typeof regenerateModuleSchema>;

/**
 * The documents for the project the caller's session is bound to.
 *
 * One controller for every document type, with the type in the path. Seven
 * documents cannot mean seven controllers — and because the type is validated
 * against the contract's enum, an unimplemented one is refused with a message
 * saying so rather than reaching a service that has no composer for it.
 *
 * The project comes from the verified session and never from the request, so
 * every id in a path — a section, a feature, a version — is scoped by that
 * session. An id belonging to another project resolves to "not found", the same
 * answer as one that never existed.
 *
 * Every mutating route takes an `expectedVersion`. A document open in two tabs is
 * ordinary, and a lost update here means somebody's paragraph quietly vanishing.
 */
@ApiTags('documents')
@ApiUnauthorizedResponse({ description: 'No valid project session.' })
@Controller({ path: 'projects/current/documents', version: '1' })
@UseGuards(ProjectSessionGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly ai: DocumentsAiService,
    private readonly repository: DocumentsRepository,
    private readonly trace: TraceabilityService,
    private readonly exports: DocumentExportService,
    private readonly projects: ProjectRepository,
    @Inject(FILE_STORAGE_PORT) private readonly storage: FileStoragePort,
  ) {}

  /**
   * The logo, read from the project's own storage, or nothing.
   *
   * By object id, never by a path or a URL: the branding contract stores a reference, so
   * there is no filename here to traverse with and no host to fetch from. A logo that
   * cannot be read is a branding error rather than a silent omission — substituting
   * somebody else's mark, or quietly dropping the one they configured, are both worse than
   * saying so.
   */
  private async logoFor(
    projectId: string,
    branding: Branding,
  ): Promise<{ logo?: { content: Buffer; contentType: 'image/png' | 'image/jpeg' } }> {
    if (!branding.logo) {
      return {};
    }

    try {
      const stream = await this.storage.getStream({
        projectId,
        objectId: branding.logo.objectId,
      });

      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }

      return {
        logo: { content: Buffer.concat(chunks), contentType: branding.logo.contentType },
      };
    } catch {
      throw new DocumentError(DOCUMENT_ERROR_CODES.EXPORT_BRANDING_INVALID, 422);
    }
  }

  @Get()
  @ApiOperation({
    summary: 'Every document and its state',
    description:
      'All seven controlled documents, in order, with their status and — where they cannot be worked on yet — why. A document locked behind an unapproved prerequisite is reported as locked rather than hidden.',
  })
  @ApiOkResponse({ description: 'The document list.' })
  async list(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ documents: readonly DocumentSummary[] }> {
    return { documents: await this.documents.list(context(request)) };
  }

  @Get('traceability')
  @ApiOperation({
    summary: 'Every approved requirement, followed through every document',
    description:
      'Walks the links the documents already record — a section’s references, a feature row’s requirement ids, a criterion’s, a work package’s — so a gap is visible rather than discovered during delivery. Nothing is inferred from prose. Assumptions and the Client Dependency Sheet are conditional: a requirement with no entry there is the ordinary case, not a gap.',
  })
  @ApiOkResponse({ description: 'The traceability view.' })
  async traceability(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ traceability: TraceabilityView }> {
    const ctx = context(request);

    return { traceability: await this.trace.view(ctx.projectId, ctx.correlationId) };
  }

  @Get(':type/traceability')
  @ApiOperation({
    summary: 'What each entry in this document traces back to',
    description:
      'The reverse direction: for a work package or a dependency row, the approved requirements behind it. An entry citing nothing is either legitimate delivery overhead or something nobody agreed to, and the response says which.',
  })
  @ApiOkResponse({ description: 'One entry per row or section.' })
  async documentTraceability(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ artifacts: readonly ArtifactTrace[] }> {
    const ctx = context(request);

    return {
      artifacts: await this.trace.reverse(ctx.projectId, documentType(type), ctx.correlationId),
    };
  }

  @Get(':type')
  @ApiOperation({ summary: 'One document, with its content and assessment' })
  @ApiParam({ name: 'type', enum: DOCUMENT_TYPES })
  @ApiOkResponse({ description: 'The document.' })
  @ApiNotFoundResponse({ description: 'No document of that type.' })
  async read(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.read(context(request), documentType(type)) };
  }

  @Post(':type/generate')
  @ApiOperation({
    summary: 'Write the document, or write it again',
    description:
      'Runs the deterministic composition, and the model on top of it when `useAi` is true. Sections a person edited are carried forward and the new text is offered beside them as a proposal; nothing a person wrote is replaced without their decision.',
  })
  @ApiCreatedResponse({ description: 'The document as written.' })
  async generate(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(generateDocumentSchema)) body: GenerateDocument,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.ai.generate(context(request), documentType(type), body) };
  }

  @Get(':type/versions')
  @ApiOperation({ summary: 'Every version of this document, newest first' })
  @ApiOkResponse({ description: 'The version list.' })
  async versions(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ versions: readonly DocumentVersionSummary[] }> {
    return { versions: await this.documents.listVersions(context(request), documentType(type)) };
  }

  @Get(':type/versions/:version')
  @ApiOperation({ summary: 'One earlier version, exactly as it stood' })
  @ApiOkResponse({ description: 'The stored version.' })
  async version(
    @Param('type') type: string,
    @Param('version') version: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.version(
        context(request),
        documentType(type),
        positiveInteger(version),
      ),
    };
  }

  @Get(':type/compare')
  @ApiOperation({ summary: 'What changed between two versions' })
  @ApiQuery({ name: 'left', required: true })
  @ApiQuery({ name: 'right', required: true })
  @ApiOkResponse({ description: 'The difference, by section or feature.' })
  async compare(
    @Param('type') type: string,
    @Query('left') left: string,
    @Query('right') right: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ diff: DocumentDiff }> {
    return {
      diff: await this.documents.compare(
        context(request),
        documentType(type),
        positiveInteger(left),
        positiveInteger(right),
      ),
    };
  }

  @Post(':type/restore')
  @ApiOperation({
    summary: 'Bring an earlier version back',
    description:
      'Copies the chosen version forward as a new one. The version it came from is untouched — history here cannot be rewound.',
  })
  @ApiCreatedResponse({ description: 'The restored document, as a new version.' })
  async restore(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(restoreVersionSchema)) body: RestoreVersion,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.restore(context(request), documentType(type), body) };
  }

  @Put(':type/sections/:sectionId')
  @ApiOperation({
    summary: 'Edit a section',
    description:
      'From here the section is yours: regeneration will offer a rewrite beside it rather than replacing it.',
  })
  @ApiOkResponse({ description: 'The document with the edit applied.' })
  async updateSection(
    @Param('type') type: string,
    @Param('sectionId') sectionId: string,
    @Body(new ZodValidationPipe(updateSectionSchema)) body: UpdateSection,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.updateSection(
        context(request),
        documentType(type),
        sectionId,
        body,
      ),
    };
  }

  @Post(':type/sections/:sectionId/regenerate')
  @ApiOperation({
    summary: 'Rewrite one section',
    description:
      'A correction instruction is treated as a request about wording. It travels as evidence rather than as an instruction, and it cannot widen scope, name a technology or change a number.',
  })
  @ApiCreatedResponse({ description: 'The document, with the section rewritten or proposed.' })
  async regenerateSection(
    @Param('type') type: string,
    @Param('sectionId') sectionId: string,
    @Body(new ZodValidationPipe(regenerateSectionSchema)) body: RegenerateSection,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.ai.regenerateSection(
        context(request),
        documentType(type),
        sectionId,
        body.expectedVersion,
        body.useAi,
        body.instruction,
      ),
    };
  }

  @Post(':type/sections/:sectionId/proposal')
  @ApiOperation({
    summary: 'Decide what happens to a suggested rewrite',
    description: 'Keep what you wrote, use the new version, or start from it and edit.',
  })
  @ApiCreatedResponse({ description: 'The document with the decision applied.' })
  async resolveProposal(
    @Param('type') type: string,
    @Param('sectionId') sectionId: string,
    @Body(new ZodValidationPipe(resolveSectionProposalSchema)) body: ResolveSectionProposal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.resolveProposal(
        context(request),
        documentType(type),
        sectionId,
        body,
      ),
    };
  }

  @Post(':type/corrections')
  @ApiOperation({
    summary: 'Apply a correction instruction',
    description:
      'What you want different, and where — the whole document, one section, one feature or one module. Treated as a request about wording: it travels as evidence rather than as an instruction, and it cannot add scope, change a technology or change an hours figure. The request is recorded with what it targeted and what came of it.',
  })
  @ApiCreatedResponse({ description: 'The document, and anything the correction could not do.' })
  async applyCorrection(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(applyCorrectionSchema)) body: ApplyCorrection,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot; limits: readonly string[] }> {
    const result = await this.ai.applyCorrection(context(request), documentType(type), body);

    return { document: result.snapshot, limits: result.limits };
  }

  @Get(':type/corrections')
  @ApiOperation({ summary: 'Every correction asked for on this document, newest first' })
  @ApiOkResponse({ description: 'The correction history.' })
  async corrections(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ corrections: readonly CorrectionInstruction[] }> {
    return {
      corrections: await this.documents.listCorrections(context(request), documentType(type)),
    };
  }

  @Post(':type/features/:featureId/regenerate')
  @ApiOperation({
    summary: 'Rewrite one feature row’s wording',
    description:
      'Every other row is carried forward unchanged. Hours are never touched — they come from the estimate you approved, and the generation schema has nowhere to put one.',
  })
  @ApiCreatedResponse({ description: 'The document, with that row rewritten or proposed.' })
  async regenerateFeature(
    @Param('type') type: string,
    @Param('featureId') featureId: string,
    @Body(new ZodValidationPipe(regenerateSectionSchema)) body: RegenerateSection,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    const result = await this.ai.regenerateFeatures(
      context(request),
      documentType(type),
      { featureIds: [featureId] },
      body.expectedVersion,
      body.useAi,
      body.instruction,
    );

    return { document: result.snapshot };
  }

  @Post(':type/features/regenerate-module')
  @ApiOperation({
    summary: 'Rewrite every row in one module',
    description: 'Rows in other modules are carried forward unchanged, hours included.',
  })
  @ApiCreatedResponse({ description: 'The document, with that module rewritten or proposed.' })
  async regenerateModule(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(regenerateModuleSchema)) body: RegenerateModule,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    const result = await this.ai.regenerateFeatures(
      context(request),
      documentType(type),
      { module: body.module },
      body.expectedVersion,
      body.useAi,
      body.instruction,
    );

    return { document: result.snapshot };
  }

  @Post(':type/features/:featureId/proposal')
  @ApiOperation({ summary: 'Decide what happens to a row’s suggested rewrite' })
  @ApiCreatedResponse({ description: 'The document with the decision applied.' })
  async resolveFeatureProposal(
    @Param('type') type: string,
    @Param('featureId') featureId: string,
    @Body(new ZodValidationPipe(resolveFeatureProposalSchema)) body: ResolveFeatureProposal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.resolveFeatureProposal(
        context(request),
        documentType(type),
        featureId,
        body,
      ),
    };
  }

  @Get(':type/features')
  @ApiOperation({ summary: 'The feature rows' })
  @ApiOkResponse({ description: 'The rows, in display order.' })
  async features(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ features: readonly FeatureRow[] }> {
    return { features: await this.documents.listFeatures(context(request), documentType(type)) };
  }

  @Patch(':type/features/:featureId')
  @ApiOperation({
    summary: 'Edit a feature row',
    description:
      'Descriptive fields only. Hours come from the estimate you approved, so they are changed there — an attempt to change one here is refused with a pointer to the estimation step.',
  })
  @ApiOkResponse({ description: 'The document with the edit applied.' })
  async updateFeature(
    @Param('type') type: string,
    @Param('featureId') featureId: string,
    @Body() raw: Record<string, unknown>,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    /*
     * Checked before validation, so the user gets the message that says where
     * hours are changed rather than "unrecognised key: effort". The strict schema
     * would refuse it either way; this makes the refusal useful.
     */
    if (attemptsEffortEdit(raw)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.EFFORT_NOT_EDITABLE_HERE, 422);
    }

    const body = updateFeatureRowSchema.parse(raw);

    return {
      document: await this.documents.updateFeature(
        context(request),
        documentType(type),
        featureId,
        body,
      ),
    };
  }

  /* ------------------------------------------------- Phase 8: structured rows */

  /*
   * One set of row endpoints for every list document. The row kind comes from the
   * document type in the path, so Acceptance Criteria and Assumptions share these
   * and a later list document needs no new route.
   */

  @Get(':type/rows')
  @ApiOperation({ summary: 'The structured entries of a list document' })
  @ApiOkResponse({ description: 'The entries, in display order.' })
  async rows(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ rows: readonly DocumentRow[] }> {
    const document = await this.documents.read(context(request), documentType(type));

    return { rows: document.rows };
  }

  @Post(':type/rows')
  @ApiOperation({
    summary: 'Add an entry by hand',
    description:
      'Marked as yours, and it asks where it came from: an entry nothing upstream produced cannot be approved without a note saying what it rests on.',
  })
  @ApiCreatedResponse({ description: 'The document with the entry added.' })
  async addRow(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(addRowSchema)) body: AddRow,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.addRow(context(request), documentType(type), body) };
  }

  @Patch(':type/rows/:rowId')
  @ApiOperation({
    summary: 'Edit one entry',
    description:
      'An assumption’s status and provenance are not editable here — those move through confirming, rejecting or settling it, where who did it is recorded.',
  })
  @ApiOkResponse({ description: 'The document with the edit applied.' })
  async updateRow(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(editRowSchema)) body: EditRow,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.updateRow(context(request), documentType(type), rowId, body),
    };
  }

  @Post(':type/rows/regenerate-group')
  @ApiOperation({
    summary: 'Rewrite every entry in one group',
    description:
      'A module for acceptance criteria, a category for assumptions. Entries outside the group are left exactly as they are.',
  })
  @ApiCreatedResponse({ description: 'The document, at a new version.' })
  async regenerateRowGroup(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(regenerateRowGroupSchema)) body: RegenerateRowGroup,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    const result = await this.ai.regenerateRows(
      context(request),
      documentType(type),
      { group: body.group },
      body,
    );

    return { document: result };
  }

  @Post(':type/rows/candidates')
  @ApiOperation({
    summary: 'Ask for assumption candidates',
    description:
      'Suggestions only. A candidate is recorded as a candidate and stays out of an approved document until somebody confirms it.',
  })
  @ApiCreatedResponse({ description: 'The document with the candidates added.' })
  async assumptionCandidates(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(generateDocumentSchema)) body: GenerateDocument,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.ai.suggestAssumptions(context(request), documentType(type), body),
    };
  }

  @Post(':type/rows/:rowId/regenerate')
  @ApiOperation({ summary: 'Rewrite one entry’s wording' })
  @ApiCreatedResponse({ description: 'The document, at a new version.' })
  async regenerateRow(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(regenerateRowSchema)) body: RegenerateRow,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    const result = await this.ai.regenerateRows(
      context(request),
      documentType(type),
      { rowIds: [rowId] },
      body,
    );

    return { document: result };
  }

  @Post(':type/rows/:rowId/proposal')
  @ApiOperation({ summary: 'Decide what happens to an entry’s suggested rewrite' })
  @ApiCreatedResponse({ description: 'The document with the decision applied.' })
  async resolveRowProposal(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(resolveRowProposalSchema)) body: ResolveRowProposal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.resolveRowProposal(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/rows/:rowId/exclude')
  @ApiOperation({ summary: 'Record that an entry is deliberately left out' })
  @ApiCreatedResponse({ description: 'The document with the exclusion recorded.' })
  async excludeRow(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(excludeRowSchema)) body: ExcludeRow,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.excludeRow(context(request), documentType(type), rowId, body),
    };
  }

  @Delete(':type/rows/:rowId')
  @ApiOperation({
    summary: 'Take an entry out of the working document',
    description:
      'Removal, not exclusion: use this for an entry that should not have been there. Every earlier version keeps it, so the history still shows what the document said and when the entry went. If it was the only thing covering approved scope, validation says so.',
  })
  @ApiOkResponse({ description: 'The document without that entry.' })
  async removeRow(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(removeRowSchema)) body: RemoveRow,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.removeRow(context(request), documentType(type), rowId, body),
    };
  }

  @Post(':type/rows/:rowId/confirm')
  @ApiOperation({
    summary: 'Stand behind an assumption',
    description:
      'The only way an assumption becomes authoritative, and it takes a person. You say what it rests on; the application records that it was you and when.',
  })
  @ApiCreatedResponse({ description: 'The document with the assumption confirmed.' })
  async confirmAssumption(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(confirmAssumptionSchema)) body: ConfirmAssumption,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.confirmAssumption(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/rows/:rowId/reject')
  @ApiOperation({ summary: 'Turn an assumption down, with a reason' })
  @ApiCreatedResponse({ description: 'The document with the rejection recorded.' })
  async rejectAssumption(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(rejectAssumptionSchema)) body: RejectAssumption,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.rejectAssumption(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/rows/:rowId/settle')
  @ApiOperation({ summary: 'Record that an assumption turned out true, or did not' })
  @ApiCreatedResponse({ description: 'The document with the outcome recorded.' })
  async settleAssumption(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(settleAssumptionSchema)) body: SettleAssumption,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.settleAssumption(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/rows/:rowId/request')
  @ApiOperation({
    summary: 'Record that a client dependency has been asked for',
    description:
      'Sets the status and stamps when it was requested, so the sheet is the record of what was chased and when rather than somebody’s recollection.',
  })
  @ApiCreatedResponse({ description: 'The document with the request recorded.' })
  async requestDependency(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(requestDependencySchema)) body: RequestDependency,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.requestDependency(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/rows/:rowId/receive')
  @ApiOperation({
    summary: 'Record that a client dependency arrived',
    description:
      'Arrival only. It does not mean the item is usable — credentials turn up that do not work, and exports arrive in the wrong shape. Checking it is a separate action.',
  })
  @ApiCreatedResponse({ description: 'The document with the arrival recorded.' })
  async receiveDependency(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(receiveDependencySchema)) body: ReceiveDependency,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.receiveDependency(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/rows/:rowId/validate')
  @ApiOperation({
    summary: 'Record what checking a client dependency showed',
    description:
      'Accepted or rejected, with a note either way. This is the only thing that unblocks the work waiting on it, and the note is what makes the decision auditable later.',
  })
  @ApiCreatedResponse({ description: 'The document with the outcome recorded.' })
  async validateDependency(
    @Param('type') type: string,
    @Param('rowId') rowId: string,
    @Body(new ZodValidationPipe(validateDependencySchema)) body: ValidateDependency,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.validateDependency(
        context(request),
        documentType(type),
        rowId,
        body,
      ),
    };
  }

  @Post(':type/exclusions')
  @ApiOperation({
    summary: 'Record that a requirement is deliberately not in this document',
    description:
      'A disposition rather than an absence: coverage counts it as handled, and the reason is kept with it.',
  })
  @ApiCreatedResponse({ description: 'The document with the exclusion recorded.' })
  async exclude(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(excludeRequirementSchema)) body: ExcludeRequirement,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.excludeRequirement(
        context(request),
        documentType(type),
        body.requirementId,
        body.reason,
        body.expectedVersion,
      ),
    };
  }

  @Get(':type/csv')
  @ApiOperation({
    summary: 'The strict eight-column CSV',
    description:
      'Exactly the schema the Feature Listing export requires: eight columns in a fixed order, every value quoted, additional roles named in the last column.',
  })
  @ApiOkResponse({ description: 'The serialised sheet.' })
  async csv(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ csv: string }> {
    return { csv: await this.documents.csv(context(request), documentType(type)) };
  }

  @Get(':type/export')
  @ApiOperation({
    summary: 'The document as a file',
    description:
      'Renders the selected version — the working one by default, an archived one when `version` is given — in one of the formats offered for that document. A read: nothing about the document changes, so no version is created and no lifecycle or currentness moves. An OUTDATED or DRAFT version exports as it stands, saying so on the page rather than being silently brought up to date.',
  })
  @ApiOkResponse({
    description: 'The file, as an attachment.',
    content: {
      'text/csv': { schema: { type: 'string', format: 'binary' } },
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
        schema: { type: 'string', format: 'binary' },
      },
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  async exportDocument(
    @Param('type') type: string,
    @Query('format') format: string,
    @Query('version') version: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const documentContext = context(request);
    const parsedFormat = z.enum(EXPORT_FORMATS).safeParse(format);

    if (!parsedFormat.success) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.UNSUPPORTED_EXPORT_FORMAT, 422);
    }

    const project = await this.projects.findByProjectId(documentContext.projectId);

    if (!project) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 404);
    }

    /*
     * Branding is re-validated on the way out rather than trusted.
     *
     * It was written through a validating boundary, but a stored document can predate a
     * schema change, and an unusable colour or logo reference must be a clear branding
     * error rather than a renderer crash three layers down.
     */
    const branding = brandingSchema.safeParse(project.branding ?? {});

    if (!branding.success) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.EXPORT_BRANDING_INVALID, 422);
    }

    const result = await this.exports.export({
      context: documentContext,
      document: documentType(type) as ProjectDocument,
      format: parsedFormat.data,
      ...(version !== undefined ? { version: positiveInteger(version) } : {}),
      projectName: project.name,
      branding: branding.data,
      ...(await this.logoFor(documentContext.projectId, branding.data)),
    });

    response
      .status(200)
      .setHeader('content-type', result.contentType)
      .setHeader('content-disposition', result.disposition)
      .setHeader('content-length', String(result.byteLength))
      /* A generated file is specific to a version and a moment; caching it would serve
         yesterday's document after a re-export. */
      .setHeader('cache-control', 'no-store')
      .end(result.content);
  }

  @Post(':type/validate')
  @ApiOperation({
    summary: 'Check the document against what it claims to be based on',
    description:
      'Deterministic checks are authoritative. A model may add findings a checker cannot see, and can never clear or downgrade one.',
  })
  @ApiCreatedResponse({ description: 'The document with its validation result.' })
  async validate(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(z.object({ useAi: z.boolean() }).strict()))
    body: { useAi: boolean },
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.ai.validate(context(request), documentType(type), body.useAi),
    };
  }

  @Post(':type/validation/acknowledge')
  @ApiOperation({ summary: 'Record that a warning has been read and accepted' })
  @ApiCreatedResponse({ description: 'The document with the warning acknowledged.' })
  async acknowledge(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(acknowledgeFindingSchema)) body: AcknowledgeFinding,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return {
      document: await this.documents.acknowledgeFinding(
        context(request),
        documentType(type),
        body.kind,
        body.expectedVersion,
      ),
    };
  }

  @Post(':type/approve')
  @ApiOperation({
    summary: 'Approve the document',
    description:
      'Requires current validation with nothing blocking. Approving unlocks whatever depends on this document.',
  })
  @ApiCreatedResponse({ description: 'The approved document.' })
  async approve(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(approveDocumentSchema)) body: ApproveDocument,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.approve(context(request), documentType(type), body) };
  }

  @Post(':type/reopen')
  @ApiOperation({
    summary: 'Withdraw approval',
    description:
      'Documents built on this one are marked out of date. None of them is regenerated or changed — that decision stays yours.',
  })
  @ApiCreatedResponse({ description: 'The reopened document.' })
  async reopen(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(reopenDocumentSchema)) body: ReopenDocument,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.reopen(context(request), documentType(type), body) };
  }

  @Post(':type/revise')
  @ApiOperation({
    summary: 'Start a new working version from an issued document',
    description:
      'The issued version is untouched and stays on the record as what was sent. A copy becomes the new working version, with every section marked as yours — somebody chose that text when they issued it.',
  })
  @ApiCreatedResponse({ description: 'The new working version.' })
  async revise(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(reopenDocumentSchema)) body: ReopenDocument,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.revise(context(request), documentType(type), body) };
  }

  @Post(':type/final')
  @ApiOperation({
    summary: 'Mark the document issued',
    description: 'Irreversible. A revision after this is a new version, not a change to this one.',
  })
  @ApiCreatedResponse({ description: 'The issued document.' })
  async markFinal(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(markFinalSchema)) body: MarkFinal,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ document: DocumentSnapshot }> {
    return { document: await this.documents.markFinal(context(request), documentType(type), body) };
  }

  @Get(':type/run/current')
  @ApiOperation({ summary: 'The current or most recent generation run' })
  @ApiOkResponse({ description: 'The run, or null when there has never been one.' })
  async currentRun(
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentRun | null> {
    const session = context(request);
    const run =
      (await this.repository.activeRun(session.projectId, documentType(type))) ??
      (await this.repository.latestRun(session.projectId, documentType(type)));

    return run ? toDocumentRun(run) : null;
  }
}

function context(request: AuthenticatedRequest): DocumentContext {
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

/**
 * A document type from the path.
 *
 * Parsed rather than cast: an unknown value is a 422 naming the problem, and an
 * unimplemented-but-declared one reaches the service, which refuses it with the
 * message that says so.
 */
function documentType(value: string): DocumentType {
  const parsed = documentTypeSchema.safeParse(value);

  if (!parsed.success) {
    throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_IMPLEMENTED, 422);
  }

  return parsed.data;
}

function positiveInteger(value: string): number {
  const parsed = z.coerce.number().int().positive().safeParse(value);

  if (!parsed.success) {
    throw new DocumentError(DOCUMENT_ERROR_CODES.VERSION_NOT_FOUND, 404);
  }

  return parsed.data;
}
