import { Injectable } from '@nestjs/common';
import {
  calculateDocumentBlockers,
  canGenerateDocument,
  canTransitionDocument,
  diffDocuments,
  DOCUMENT_DEPENDENCIES,
  DOCUMENT_DESCRIPTIONS,
  DOCUMENT_ERROR_CODES,
  DOCUMENT_LABELS,
  DOCUMENT_ORDER,
  DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_SHAPE_BY_TYPE,
  DOCUMENT_TYPES,
  downstreamDocuments,
  featureListingCsv,
  correctionAuditMetadata,
  hasFeatureProposal,
  hasProposal,
  IMPLEMENTED_DOCUMENT_TYPES,
  currentnessFrom,
  isAuthoritativeState,
  isRowProtected,
  rowNeedsAttribution,
  rowsAwaitingDecision,
  acceptanceCriterionSchema,
  assumptionSchema,
  canTransitionDependency,
  clientDependencySchema,
  isDependencySatisfied,
  nextDependencyKey,
  nextOutlineNumber,
  reverseDependencyIndex,
  secretsInDependency,
  workPackageSchema,
  canTransitionAssumption,
  candidateToAssumption,
  nextAssumptionKey,
  nextCriterionKey,
  isDocumentAuthoritative,
  isDocumentEditable,
  isDocumentRunning,
  isImplementedDocumentType,
  isSectionProtected,
  lockFor,
  mayReplaceDirectly,
  mayReplaceFeatureDirectly,
  validationIsCurrent,
  validationPermitsApproval,
  worstSeverity,
  type ApplyCorrection,
  type ApproveDocument,
  type ContentEntry,
  type CorrectionInstruction,
  type CorrectionOutcome,
  type DocumentDiff,
  type DocumentSection,
  type DocumentSnapshot,
  type AddRow,
  type Assumption,
  type AssumptionCandidate,
  type AuditEventType,
  type ConfirmAssumption,
  type DocumentReference,
  type DocumentRow,
  type DocumentState,
  type EditRow,
  type ExcludeRow,
  type RejectAssumption,
  type RemoveRow,
  type ResolveRowProposal,
  type SettleAssumption,
  type DocumentSummary,
  type ClientDependency,
  type DependencyStatus,
  type DocumentChangeType,
  type WorkPackage,
  type ReverseDependencyIndex,
  type ReceiveDependency,
  type RequestDependency,
  type ValidateDependency,
  type DocumentType,
  type DocumentValidation,
  type DocumentVersionSummary,
  type FeatureRow,
  type GenerateDocument,
  type MarkFinal,
  type ReopenDocument,
  type ResolveFeatureProposal,
  type ResolveSectionProposal,
  type RestoreVersion,
  type UpdateFeatureRow,
  type UpdateSection,
  type UpstreamKind,
  type ValidationFinding,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { DocumentError } from './documents.errors';
import { DocumentsRepository } from './documents.repository';
import { requirementReference } from './composers/composer.types';
import {
  documentOutdatedReasonsFor,
  UpstreamReader,
  type AuthorityVersions,
  type UpstreamSnapshot,
} from './upstream.reader';
import { AcceptanceCriteriaComposer } from './composers/acceptance-criteria.composer';
import { AssumptionsComposer } from './composers/assumptions.composer';
import { ClientDependencyComposer } from './composers/client-dependency.composer';
import { FeatureListingComposer } from './composers/feature-listing.composer';
import { StatementOfWorkComposer } from './composers/statement-of-work.composer';
import { UnderstandingComposer } from './composers/understanding.composer';
import { WorkBreakdownComposer } from './composers/work-breakdown.composer';
import type { ComposedContent, DocumentComposer } from './composers/composer.types';
import {
  featureFields,
  rowFields,
  rowSummary,
  rowTitle,
  toDocumentSnapshot,
  toFeatureRecord,
  payloadText,
  toFeatureRow,
  toRow,
  toSection,
  toVersionSummary,
  type StoredContent,
} from './documents.mapper';
import type { DocumentDocument, DocumentRowDocument } from './schemas/document.schema';

export interface DocumentContext {
  readonly projectId: string;
  readonly correlationId: string;
}

/**
 * The shared document engine.
 *
 * One service for every controlled document. The per-document knowledge lives in
 * a composer — what sections exist, which requirements belong where, what makes
 * this document valid — and everything else is here, written once:
 *
 * - the status machine, and refusing a transition that is not in the table;
 * - versioning, and never mutating an approved version in place;
 * - edit protection, and proposing rather than overwriting;
 * - the dependency graph, locking, and outdated propagation;
 * - validation, approval, reopening and issuing;
 * - audit, with document metadata and never document prose.
 *
 * Adding Acceptance Criteria in a later phase is a composer and a row in
 * `DOCUMENT_DEPENDENCIES`. Nothing in this file changes, and that is the whole
 * point of Phase 7 existing before Documents 3 to 7 rather than alongside them.
 */
@Injectable()
export class DocumentsService {
  private readonly composers: ReadonlyMap<DocumentType, DocumentComposer>;

  constructor(
    private readonly repository: DocumentsRepository,
    private readonly upstream: UpstreamReader,
    private readonly audit: AuditService,
    understanding: UnderstandingComposer,
    private readonly featureListing: FeatureListingComposer,
    private readonly acceptanceCriteria: AcceptanceCriteriaComposer,
    private readonly assumptions: AssumptionsComposer,
    private readonly statementOfWork: StatementOfWorkComposer,
    private readonly workBreakdown: WorkBreakdownComposer,
    private readonly clientDependencies: ClientDependencyComposer,
  ) {
    this.composers = new Map<DocumentType, DocumentComposer>([
      [understanding.type, understanding],
      [featureListing.type, featureListing],
      [acceptanceCriteria.type, acceptanceCriteria],
      [assumptions.type, assumptions],
      [statementOfWork.type, statementOfWork],
      [workBreakdown.type, workBreakdown],
      [clientDependencies.type, clientDependencies],
    ]);
  }

  /* --------------------------------------------------------------- reads */

  /**
   * Every document's state, whether it exists or not.
   *
   * Every declared document appears, with its status or the reason it is locked.
   * Anything not yet implemented is marked unavailable rather than hidden — a user
   * who can see a document is coming, and that it is not here yet, is better
   * informed than one who sees a short list and wonders. As of Phase 9 all seven
   * are implemented, so what this reports now is locking rather than absence.
   */
  async list(context: DocumentContext): Promise<readonly DocumentSummary[]> {
    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const records = await this.repository.findAll(context.projectId);
    const byType = new Map(records.map((record) => [record.type as DocumentType, record]));

    /*
     * Both axes for every document, computed once. Locking asks for both: a
     * prerequisite that is approved but stale does not unlock what follows it.
     */
    const states = Object.fromEntries(
      records.map((record) => [
        record.type,
        {
          status: record.status as DocumentSnapshot['status'],
          currentness: currentnessFrom(this.outdatedFor(record, upstream)),
        },
      ]),
    ) as Partial<Record<DocumentType, DocumentState>>;

    return DOCUMENT_TYPES.map((type) => {
      const record = byType.get(type);
      const lock = lockFor(
        type,
        { availableUpstream: this.availableUpstream(upstream), documentStates: states },
        IMPLEMENTED_DOCUMENT_TYPES,
      );

      return {
        type,
        label: DOCUMENT_LABELS[type],
        description: DOCUMENT_DESCRIPTIONS[type],
        order: DOCUMENT_ORDER[type],
        status: (record?.status as DocumentSnapshot['status']) ?? 'NOT_STARTED',
        lock: lock ? { reason: lock.reason, summary: lock.summary } : null,
        implemented: isImplementedDocumentType(type),
        version: record?.version ?? 0,
        currentness: states[type]?.currentness ?? 'CURRENT',
        blockerCount: (record?.blockers ?? []).length,
        validationSeverity: (record?.validation as { severity?: string } | null)?.severity ?? null,
        ...(record ? { updatedAt: record.updatedAt.toISOString() } : {}),
      };
    }).sort((first, second) => first.order - second.order);
  }

  /** One document, with its content and a freshly computed assessment. */
  async read(context: DocumentContext, type: DocumentType): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      return this.emptySnapshot(context, type);
    }

    return this.assemble(context, record);
  }

  async listVersions(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<readonly DocumentVersionSummary[]> {
    this.assertImplemented(type);

    const versions = await this.repository.listVersions(context.projectId, type);
    const upstream = await this.upstream.read(context.projectId, context.correlationId);

    /*
     * Each version is judged against today's upstream on its *own* recorded
     * versions. That is what lets the history say "the version issued in March is
     * no longer current" without anything in the March document changing.
     */
    return versions.map((version) =>
      toVersionSummary(
        version,
        currentnessFrom(
          documentOutdatedReasonsFor(
            { ...version.toObject(), type, outdatedReasons: [] },
            this.authorityVersions(upstream),
          ),
        ),
      ),
    );
  }

  async version(
    context: DocumentContext,
    type: DocumentType,
    version: number,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const stored = await this.repository.findVersion(context.projectId, type, version);

    if (!stored) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.VERSION_NOT_FOUND, 404);
    }

    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 404);
    }

    return toDocumentSnapshot(record, {
      sections: stored.sections as unknown as DocumentSection[],
      features: stored.features as unknown as FeatureRow[],
      rows: (stored.rows ?? []) as unknown as DocumentRow[],
      version: stored.version,
      status: stored.status as DocumentSnapshot['status'],
    });
  }

  /** What changed between two versions, keyed by section or feature. */
  async compare(
    context: DocumentContext,
    type: DocumentType,
    left: number,
    right: number,
  ): Promise<DocumentDiff> {
    const before = await this.version(context, type, left);
    const after = await this.version(context, type, right);

    return diffDocuments(
      { version: left, entries: this.contentEntries(before) },
      { version: right, entries: this.contentEntries(after) },
    );
  }

  /** The strict eight-column CSV, exactly as it would be exported. */
  async csv(context: DocumentContext, type: DocumentType): Promise<string> {
    if (DOCUMENT_SHAPE_BY_TYPE[type] !== 'ROWS') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422);
    }

    const snapshot = await this.read(context, type);

    return featureListingCsv(snapshot.features);
  }

  /* ---------------------------------------------------------- generation */

  /**
   * Write the document, or write it again.
   *
   * The deterministic path only. `DocumentsAiService.generate` wraps this and
   * replaces the section bodies with prose when a provider is configured — which
   * is why a deployment with none produces a complete document rather than an
   * error.
   *
   * Three rules are enforced here rather than trusted to callers.
   *
   * **The lock is checked against the graph.** Feature Listing cannot be written
   * while Our Understanding is unapproved, whatever the request says.
   *
   * **A new version is created, never an overwrite.** The previous content is
   * archived first, so an approved version stays readable exactly as approved.
   *
   * **Protected sections survive.** A section a person wrote is carried forward
   * untouched, and the newly generated body becomes a proposal beside it.
   */
  async generate(
    context: DocumentContext,
    type: DocumentType,
    request: GenerateDocument,
    composed?: ComposedContent,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    this.assertUnlocked(type, upstream);

    const existing = await this.repository.find(context.projectId, type);

    if (
      existing?.recordVersion !== undefined &&
      existing.recordVersion !== request.expectedVersion
    ) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 409, 'version_conflict');
    }

    if (existing && isDocumentRunning(existing.status as DocumentSnapshot['status'])) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATING, 409);
    }

    if (existing?.status === 'FINAL') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_FINAL, 409);
    }

    /*
     * The stored status, plainly. Regenerating an approved document is legal —
     * it is what the screen tells somebody to do when the inputs have moved — and
     * with currentness on its own axis that is a fact about `APPROVED` rather than
     * a special case about staleness.
     */
    if (existing && !canGenerateDocument(existing.status as DocumentSnapshot['status'])) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.INVALID_STATUS_TRANSITION, 409);
    }

    const composer = this.composerFor(type);
    const content = composed ?? composer.compose(upstream.context);
    const previous = existing ? await this.currentContent(context.projectId, existing) : null;

    /* Archive what is being replaced before anything is written. */
    if (existing && previous) {
      await this.archive(context.projectId, existing, previous);
    }

    const version = await this.repository.nextVersion(context.projectId, type);
    const now = new Date();

    await this.audit.record({
      type: 'DOCUMENT_GENERATION_STARTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, version, useAi: request.useAi },
    });

    const sections = this.mergeSections(content, previous?.sections ?? [], version, now);
    const features = this.buildFeatures(content, previous?.features ?? [], version);
    const rows = this.buildRows(content, previous?.rows ?? [], version, now);

    const record = existing
      ? await this.repository.update(context.projectId, type, existing.recordVersion, {
          version,
          status: 'DRAFT',
          ...this.upstreamFields(upstream),
          /*
           * Regenerating is how a document catches up, so the reasons it had fallen
           * behind are cleared and the prerequisite versions re-recorded. Without
           * this a document that went out of date because a prerequisite moved
           * could never be current again: the stored reason would outlive the
           * regeneration that answered it.
           *
           * Regeneration cannot happen while a prerequisite is unapproved — the
           * lock check refuses it — so by this point the prerequisites are both
           * approved and current.
           */
          outdatedReasons: [],
          prerequisiteVersions: await this.prerequisiteVersions(context.projectId, type),
          supersedesVersion: existing.version,
          regenerationReason: request.reason ?? '',
          validation: null,
        })
      : await this.repository.create({
          documentId: DocumentsRepository.newId('doc'),
          projectId: context.projectId,
          type,
          version,
          status: 'DRAFT',
          title: DOCUMENT_LABELS[type],
          ...this.upstreamFields(upstream),
          prerequisiteVersions: await this.prerequisiteVersions(context.projectId, type),
          regenerationReason: request.reason ?? '',
          schemaVersion: DOCUMENT_SCHEMA_VERSION,
        });

    if (!record) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 409, 'version_conflict');
    }

    await this.repository.replaceSections(context.projectId, type, version, sections);
    await this.repository.replaceFeatures(context.projectId, type, version, features);

    if (composer.rowKind) {
      await this.repository.replaceRows(context.projectId, type, composer.rowKind, version, rows);
    }

    /*
     * The new version is archived immediately, not only when it is superseded.
     * `document_versions` is what "every version of this document" reads, and a
     * version that only appears once it has been replaced is a version nobody can
     * point at while they are working on it.
     */
    await this.archive(
      context.projectId,
      record,
      await this.currentContent(context.projectId, record),
      undefined,
      undefined,
      { changeType: existing ? 'REGENERATED' : 'GENERATED' },
    );

    await this.audit.record({
      type: 'DOCUMENT_GENERATION_COMPLETED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: type,
        version,
        sectionCount: sections.length,
        featureCount: features.length,
        rowCount: rows.length,
      },
    });

    return this.reload(context, type);
  }

  /* ------------------------------------------------------------ sections */

  /** Edit a section. From here it is protected from silent replacement. */
  async updateSection(
    context: DocumentContext,
    type: DocumentType,
    sectionId: string,
    request: UpdateSection,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const section = await this.repository.findSection(context.projectId, sectionId, record.version);

    if (section?.type !== type || section.documentVersion !== record.version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
    }

    await this.repository.updateSection(context.projectId, sectionId, record.version, {
      body: request.body,
      ...(request.title ? { title: request.title } : {}),
      /*
       * `USER_AUTHORED` when the section was empty and a person filled it,
       * `USER_EDITED` when they changed generated prose. Both are protected; the
       * distinction is worth keeping because it answers "did the model write any
       * of this?" months later.
       */
      origin: section.body.trim().length === 0 ? 'USER_AUTHORED' : 'USER_EDITED',
      proposedBody: '',
    });

    await this.afterContentChange(
      context,
      type,
      record,
      'DOCUMENT_EDITED',
      {
        sectionKey: section.key,
      },
      'SECTION_EDITED',
    );

    return this.reload(context, type);
  }

  /**
   * Rewrite one section.
   *
   * The deterministic half. `DocumentsAiService` supplies `body` when a provider
   * is configured; without one, the section is recomposed from the requirements,
   * which is a real answer rather than a failure.
   */
  async regenerateSection(
    context: DocumentContext,
    type: DocumentType,
    sectionId: string,
    expectedVersion: number,
    body: string,
    reason?: string,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, expectedVersion);
    const section = await this.repository.findSection(context.projectId, sectionId, record.version);

    if (section?.type !== type || section.documentVersion !== record.version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
    }

    const protectedSection = isSectionProtected(section.origin as DocumentSection['origin']);

    await this.repository.updateSection(context.projectId, sectionId, record.version, {
      /*
       * The whole edit-authority rule, in one branch. A section nobody has
       * touched is replaced. A section a person wrote keeps its body and gains a
       * proposal, and the decision is theirs — see `resolveProposal`.
       */
      ...(protectedSection ? { proposedBody: body, proposedAt: new Date() } : { body }),
      regenerationReason: reason ?? '',
    });

    await this.afterContentChange(
      context,
      type,
      record,
      'DOCUMENT_SECTION_REGENERATED',
      {
        sectionKey: section.key,
        proposedOnly: protectedSection,
      },
      'TARGETED_REGENERATION',
    );

    return this.reload(context, type);
  }

  /** Keep what you wrote, take the rewrite, or start from it and edit. */
  async resolveProposal(
    context: DocumentContext,
    type: DocumentType,
    sectionId: string,
    request: ResolveSectionProposal,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const section = await this.repository.findSection(context.projectId, sectionId, record.version);

    if (section?.type !== type) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
    }

    if (!section.proposedBody) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.NO_PROPOSAL_TO_RESOLVE, 422);
    }

    const body =
      request.decision === 'KEEP_CURRENT'
        ? section.body
        : request.decision === 'ACCEPT_GENERATED_REVISION'
          ? section.proposedBody
          : (request.body ?? section.proposedBody);

    await this.repository.updateSection(context.projectId, sectionId, record.version, {
      body,
      /*
       * Accepting a rewrite does not make the section the model's again. The
       * person chose it, so it stays protected — otherwise the next regeneration
       * would overwrite a decision they just made.
       */
      origin: 'USER_EDITED',
      proposedBody: '',
    });

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      sectionKey: section.key,
      decision: request.decision,
    });

    return this.reload(context, type);
  }

  /* ------------------------------------------------------------ features */

  async listFeatures(context: DocumentContext, type: DocumentType): Promise<readonly FeatureRow[]> {
    const snapshot = await this.read(context, type);

    return snapshot.features;
  }

  /**
   * Edit a row's descriptive fields.
   *
   * Effort is not among them, and the refusal is a signpost rather than a wall:
   * `EFFORT_NOT_EDITABLE_HERE` says where hours are changed and why it matters
   * that the change is recorded there. Forking the estimate inside a document is
   * how a proposal and a plan start disagreeing with nobody noticing.
   */
  async updateFeature(
    context: DocumentContext,
    type: DocumentType,
    featureId: string,
    request: UpdateFeatureRow,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const feature = await this.repository.findFeature(context.projectId, featureId, record.version);

    if (feature?.type !== type || feature.documentVersion !== record.version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.FEATURE_NOT_FOUND, 404);
    }

    const { expectedVersion: _ignored, ...fields } = request;

    await this.repository.updateFeature(context.projectId, featureId, record.version, {
      ...fields,
      reviewStatus: 'USER_EDITED',
    });

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      featureId,
      fields: Object.keys(fields),
    });

    return this.reload(context, type);
  }

  /** Record that a requirement is deliberately not in this document. */
  async excludeRequirement(
    context: DocumentContext,
    type: DocumentType,
    requirementId: string,
    reason: string,
    expectedVersion: number,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, expectedVersion);
    const upstream = await this.upstream.read(context.projectId, context.correlationId);

    if (!upstream.context.requirements.some((requirement) => requirement.key === requirementId)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.UNKNOWN_REQUIREMENT, 422);
    }

    const exclusions = [
      ...record.exclusions.filter((entry) => entry.requirementId !== requirementId),
      { requirementId, reason, excludedAt: new Date() },
    ];

    await this.repository.update(context.projectId, type, record.recordVersion, { exclusions });

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      excludedRequirement: requirementId,
    });

    return this.reload(context, type);
  }

  /* ---------------------------------------------------------- validation */

  /**
   * Run validation and store the result.
   *
   * Deterministic findings only; `DocumentsAiService.validate` adds the
   * model-assisted ones on top and cannot remove any of these.
   */
  async validate(
    context: DocumentContext,
    type: DocumentType,
    extra: readonly ValidationFinding[] = [],
    modelAssisted = false,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_GENERATED, 422);
    }

    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const content = await this.currentContent(context.projectId, record);
    const composer = this.composerFor(type);

    const findings = [
      ...composer.validate({
        context: upstream.context,
        sections: content.sections.map((section) => ({
          key: section.key,
          body: section.body,
          references: section.references.map((reference) => reference.id),
        })),
        rows: content.rows,
        features: content.features,
        excludedRequirementIds: record.exclusions.map((entry) => entry.requirementId),
        baselineCurrent: this.baselineCurrent(record, upstream),
      }),
      ...extra,
    ];

    const validation: DocumentValidation = {
      validationId: DocumentsRepository.newId('dvl'),
      documentVersion: record.version,
      ranAt: new Date().toISOString(),
      severity: worstSeverity(findings),
      findings,
      modelAssisted,
    };

    await this.repository.recordValidation({
      validationId: validation.validationId,
      projectId: context.projectId,
      type,
      documentVersion: record.version,
      severity: validation.severity,
      findings: findings,
      modelAssisted,
    });

    await this.repository.update(context.projectId, type, record.recordVersion, {
      validation: validation,
    });

    await this.audit.record({
      type: type === 'FEATURE_LISTING' ? 'FEATURE_LIST_VALIDATED' : 'DOCUMENT_VALIDATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: type,
        version: record.version,
        severity: validation.severity,
        findingCount: findings.length,
      },
    });

    return this.reload(context, type);
  }

  /** Record that a warning has been read and accepted. */
  async acknowledgeFinding(
    context: DocumentContext,
    type: DocumentType,
    kind: string,
    expectedVersion: number,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, expectedVersion);
    const validation = record.validation as unknown as DocumentValidation | null;

    const target = validation?.findings.find(
      (finding) => finding.kind === kind && finding.severity === 'WARNING',
    );

    if (!validation || !target) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.NO_FINDING_TO_ACKNOWLEDGE, 422);
    }

    const findings = validation.findings.map((finding) =>
      finding.kind === kind && finding.severity === 'WARNING'
        ? { ...finding, acknowledgedAt: new Date().toISOString() }
        : finding,
    );

    await this.repository.update(context.projectId, type, record.recordVersion, {
      validation: {
        ...validation,
        findings,
        severity: worstSeverity(findings),
      },
    });

    return this.reload(context, type);
  }

  /* ------------------------------------------------------------- approval */

  /**
   * Approve, which is what unlocks whatever depends on this document.
   *
   * Requires current validation with no blocking finding, and no blocker. The
   * validation must belong to *this* version — approving against a result from
   * two edits ago would be approving something nobody checked.
   */
  async approve(
    context: DocumentContext,
    type: DocumentType,
    request: ApproveDocument,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.expect(context, type, request.expectedVersion);
    const status = record.status as DocumentSnapshot['status'];

    const snapshot = await this.assemble(context, record);

    /*
     * Checked before both the already-approved and the transition complaints. A
     * document that is approved *and* stale answers "already approved" only in a
     * bookkeeping sense; what the user needs to know is that something upstream
     * moved, which is also what the screen is already showing them.
     */
    if (snapshot.outdatedReasons.length > 0) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_UPSTREAM_STALE, 422, undefined, {
        outdatedReasons: snapshot.outdatedReasons,
      });
    }

    if (isDocumentAuthoritative(status)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_ALREADY_APPROVED, 409);
    }

    if (!canTransitionDocument(status, 'APPROVED')) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.INVALID_STATUS_TRANSITION, 409);
    }

    const validation = snapshot.validation;

    if (!validationIsCurrent(validation, record.version)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_VALIDATED, 422);
    }

    if (!validationPermitsApproval(validation) || snapshot.blockers.length > 0) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_HAS_BLOCKERS, 422, undefined, {
        blockers: snapshot.blockers,
      });
    }

    const now = new Date();

    await this.repository.update(context.projectId, type, record.recordVersion, {
      status: 'APPROVED',
      approvedAt: now,
    });

    /* An approved version is immutable from here, so it is archived now. */
    await this.archive(
      context.projectId,
      record,
      await this.currentContent(context.projectId, record),
      'APPROVED',
      now,
    );

    await this.audit.record({
      type: 'DOCUMENT_APPROVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: type,
        version: record.version,
        ...(request.note ? { hasNote: true } : {}),
      },
    });

    return this.reload(context, type);
  }

  /**
   * Withdraw approval.
   *
   * Everything built on this document goes out of date — not regenerated, not
   * deleted. It keeps saying what it said, and the user decides what to do. A
   * dependent document that quietly rewrote itself when an upstream one was
   * reopened would be the worst possible behaviour here.
   */
  async reopen(
    context: DocumentContext,
    type: DocumentType,
    request: ReopenDocument,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.expect(context, type, request.expectedVersion);
    const status = record.status as DocumentSnapshot['status'];

    /*
     * An issued document is not reopened — it is revised. The issued version stays
     * exactly as it was sent, and a new working version is created beside it. That
     * is the whole difference between approved and issued.
     */
    if (status === 'FINAL') {
      return this.revise(context, type, request);
    }

    if (status !== 'APPROVED') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_APPROVED, 409);
    }

    /*
     * Reopening cuts a **new working version** rather than reclassifying the approved
     * one.
     *
     * Flipping the status in place looks simpler and quietly destroys the record: the
     * archived version row is keyed by version number, so the next edit would rewrite
     * v5's status from APPROVED to DRAFT and clear its `approvedAt`. The history would
     * then be unable to say that v5 was ever approved — and "which version did we
     * approve, and when?" is the question a history exists to answer.
     *
     * So v5 stays approved and immutable, and work continues on v6. This is the same
     * shape as revising an issued document; the difference is only which status the
     * preserved version carries.
     */
    const approved = await this.currentContent(context.projectId, record);

    await this.archive(context.projectId, record, approved, 'APPROVED', record.approvedAt);

    const version = await this.repository.nextVersion(context.projectId, type);
    const now = new Date();

    await this.repository.replaceSections(
      context.projectId,
      type,
      version,
      approved.sections.map((section) => ({
        sectionId: DocumentsRepository.newId('dsc'),
        documentVersion: version,
        key: section.key,
        title: section.title,
        order: section.order,
        body: section.body,
        origin: section.origin,
        omittedReason: section.omittedReason ?? '',
        references: section.references,
        proposed: null,
        createdAt: now,
      })),
    );

    await this.repository.replaceFeatures(
      context.projectId,
      type,
      version,
      approved.features.map((feature) =>
        toFeatureRecord(feature, version, { featureId: DocumentsRepository.newId('ftr') }),
      ),
    );

    const reopenComposer = this.composerFor(type);

    if (reopenComposer.rowKind) {
      await this.repository.replaceRows(
        context.projectId,
        type,
        reopenComposer.rowKind,
        version,
        approved.rows.map((row, index) => ({
          rowId: DocumentsRepository.newId('drw'),
          documentVersion: version,
          order: index,
          origin: row.origin,
          attribution: row.attribution ?? '',
          payload: row.payload as Record<string, unknown>,
          proposed: row.proposed ?? null,
          references: row.references,
          excludedReason: row.excludedReason ?? '',
        })),
      );
    }

    /*
     * The working version starts with no validation: the stored result described
     * content nobody has re-read against today's inputs. `approvedAt` is unset on the
     * working record — the approval belongs to the version that kept it.
     */
    await this.repository.update(
      context.projectId,
      type,
      record.recordVersion,
      {
        version,
        status: 'NEEDS_REVISION',
        supersedesVersion: record.version,
        regenerationReason: request.reason,
        validation: null,
      },
      ['approvedAt'],
    );

    const reopened = await this.repository.find(context.projectId, type);

    if (reopened) {
      await this.archive(
        context.projectId,
        reopened,
        await this.currentContent(context.projectId, reopened),
        undefined,
        undefined,
        { changeType: 'REOPENED', revisedFromVersion: record.version },
      );
    }

    await this.audit.record({
      type: 'DOCUMENT_REOPENED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, approvedVersion: record.version, newVersion: version },
    });

    await this.markDependentsOutdated(context, type);

    return this.reload(context, type);
  }

  /**
   * Start a new working version from an issued document.
   *
   * The issued version is not touched: it keeps its `FINAL` status and its content
   * in `document_versions`, which is what makes "what did the client receive?"
   * answerable afterwards. The new version begins as a copy, in `DRAFT`, and every
   * section is marked as a person's — somebody chose that text when they issued it,
   * so the next regeneration has to ask before replacing it.
   */
  async revise(
    context: DocumentContext,
    type: DocumentType,
    request: ReopenDocument,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.expect(context, type, request.expectedVersion);

    if (record.status !== 'FINAL') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_APPROVED, 409);
    }

    const issued = await this.currentContent(context.projectId, record);
    const upstream = await this.upstream.read(context.projectId, context.correlationId);

    /* The issued version, recorded as issued, before anything else happens. */
    await this.archive(context.projectId, record, issued, 'FINAL', undefined, {
      changeType: 'ISSUED',
    });

    const version = await this.repository.nextVersion(context.projectId, type);
    const now = new Date();

    await this.repository.replaceSections(
      context.projectId,
      type,
      version,
      issued.sections.map((section) => ({
        sectionId: DocumentsRepository.newId('dsc'),
        documentVersion: version,
        key: section.key,
        title: section.title,
        order: section.order,
        body: section.body,
        origin: 'USER_EDITED',
        omittedReason: section.omittedReason ?? '',
        references: section.references,
        proposedBody: '',
        regenerationReason: `Revised from issued version ${record.version}`,
        updatedAt: now,
      })),
    );

    await this.repository.replaceFeatures(
      context.projectId,
      type,
      version,
      issued.features.map((feature) =>
        toFeatureRecord(feature, version, { featureId: DocumentsRepository.newId('ftr') }),
      ),
    );

    /*
     * The new working version is stamped with today's authority and starts with no
     * validation. That is what "revise" means: the issued version stays behind as
     * the record of what was sent against the inputs of the day, and work resumes
     * against the project as it stands now.
     *
     * The text has been carried forward unread, so this is not a claim that the
     * content matches the new baseline — clearing `validation` is what makes that
     * claim impossible to skip. The document is `DRAFT`, and approving it requires
     * a fresh validation whose coverage and citation checks run against the
     * current baseline. A paragraph that no longer matches is caught there, by
     * reading it, rather than by a version number left deliberately stale.
     */
    await this.repository.update(
      context.projectId,
      type,
      record.recordVersion,
      {
        version,
        status: 'DRAFT',
        supersedesVersion: record.version,
        regenerationReason: request.reason,
        validation: null,
        outdatedReasons: [],
        ...this.upstreamFields(upstream),
        prerequisiteVersions: await this.prerequisiteVersions(context.projectId, type),
      },
      ['finalAt', 'approvedAt'],
    );

    /* The working revision, recorded as opened beside the issued version. */
    const revised = await this.repository.find(context.projectId, type);

    if (revised) {
      await this.archive(
        context.projectId,
        revised,
        await this.currentContent(context.projectId, revised),
        undefined,
        undefined,
        { changeType: 'REVISED_FROM_FINAL', revisedFromVersion: record.version },
      );
    }

    await this.audit.record({
      type: 'DOCUMENT_REVISION_CREATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, issuedVersion: record.version, newVersion: version },
    });

    await this.markDependentsOutdated(context, type);

    return this.reload(context, type);
  }

  /** Mark issued. The issued version is immutable from then on. */
  async markFinal(
    context: DocumentContext,
    type: DocumentType,
    request: MarkFinal,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.expect(context, type, request.expectedVersion);
    const status = record.status as DocumentSnapshot['status'];

    /*
     * Issuing is the most consequential thing this application does — the document
     * leaves the building. Doing it while an input has moved would put a stale
     * document on somebody's desk with our name on it.
     */
    const upstream = await this.upstream.read(context.projectId, context.correlationId);

    if (this.outdatedFor(record, upstream).length > 0) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_UPSTREAM_STALE, 422);
    }

    if (!canTransitionDocument(status, 'FINAL')) {
      throw new DocumentError(
        status === 'FINAL'
          ? DOCUMENT_ERROR_CODES.DOCUMENT_FINAL
          : DOCUMENT_ERROR_CODES.DOCUMENT_NOT_APPROVED,
        409,
      );
    }

    const now = new Date();

    await this.repository.update(context.projectId, type, record.recordVersion, {
      status: 'FINAL',
      finalAt: now,
    });
    /*
     * The archived row records it too. A version carrying `finalAt` while its status
     * still said APPROVED was a row that contradicted itself, and "which version did
     * the client receive?" has to be answerable from the history alone rather than by
     * knowing that a later revise would have corrected it.
     */
    await this.repository.updateVersion(context.projectId, type, record.version, {
      status: 'FINAL',
      finalAt: now,
    });

    await this.audit.record({
      type: 'DOCUMENT_MARKED_FINAL',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, version: record.version },
    });

    return this.reload(context, type);
  }

  /* ------------------------------------------------------------- restore */

  /**
   * Bring an earlier version back as the current content.
   *
   * A copy forward, never a rewind: the restored content becomes a new version,
   * and the version it came from stays exactly where it was. History that can be
   * rewound is history nobody can rely on.
   */
  async restore(
    context: DocumentContext,
    type: DocumentType,
    request: RestoreVersion,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const stored = await this.repository.findVersion(context.projectId, type, request.version);

    if (!stored) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.VERSION_NOT_FOUND, 404);
    }

    const current = await this.currentContent(context.projectId, record);
    await this.archive(context.projectId, record, current);

    const version = await this.repository.nextVersion(context.projectId, type);
    const now = new Date();

    const sections = (stored.sections as unknown as DocumentSection[]).map((section) => ({
      sectionId: DocumentsRepository.newId('dsc'),
      projectId: context.projectId,
      type,
      documentVersion: version,
      key: section.key,
      title: section.title,
      order: section.order,
      body: section.body,
      /*
       * A restored section is protected. Somebody chose this text, and the next
       * regeneration must ask before replacing it.
       */
      origin: 'USER_EDITED',
      omittedReason: section.omittedReason ?? '',
      references: section.references,
      proposedBody: '',
      regenerationReason: `Restored from version ${request.version}`,
      updatedAt: now,
    }));

    const features = (stored.features as unknown as FeatureRow[]).map((feature) =>
      toFeatureRecord(feature, version, { featureId: DocumentsRepository.newId('ftr') }),
    );

    /*
     * Restored rows are protected for the same reason restored sections are:
     * somebody chose this content, so the next regeneration proposes rather than
     * replaces. `USER_EDITED` rather than `USER_DEFINED` — it came from a
     * generated version originally, and it keeps its references, so it is still
     * traceable and needs no attribution.
     */
    const restoredRows = ((stored.rows ?? []) as unknown as DocumentRow[]).map((row, index) => ({
      rowId: DocumentsRepository.newId('drw'),
      documentVersion: version,
      order: index,
      origin: 'USER_EDITED',
      attribution: row.attribution ?? '',
      payload: row.payload as Record<string, unknown>,
      proposed: null,
      references: row.references,
      excludedReason: row.excludedReason ?? '',
    }));

    await this.repository.update(context.projectId, type, record.recordVersion, {
      version,
      status: 'DRAFT',
      supersedesVersion: record.version,
      regenerationReason: `Restored from version ${request.version}`,
      validation: null,
    });

    await this.repository.replaceSections(context.projectId, type, version, sections);
    await this.repository.replaceFeatures(context.projectId, type, version, features);

    const restoreComposer = this.composerFor(type);

    if (restoreComposer.rowKind) {
      await this.repository.replaceRows(
        context.projectId,
        type,
        restoreComposer.rowKind,
        version,
        restoredRows,
      );
    }

    /*
     * The new working version, archived with where its content came from.
     *
     * Recorded now rather than inferred later: a diff between this version and the one
     * before it cannot tell "restored from version 4" from "coincidentally edited to
     * match version 4", and the history is the only place that distinction survives.
     */
    const restored = await this.repository.find(context.projectId, type);

    if (restored) {
      await this.archive(
        context.projectId,
        restored,
        await this.currentContent(context.projectId, restored),
        undefined,
        undefined,
        { changeType: 'RESTORED', restoredFromVersion: request.version },
      );
    }

    await this.audit.record({
      type: 'DOCUMENT_VERSION_RESTORED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, restoredFrom: request.version, newVersion: version },
    });

    return this.reload(context, type);
  }

  /* --------------------------------------------------------- composition */

  /** The composer for a type, or a refusal for one that has none. */
  composerFor(type: DocumentType): DocumentComposer {
    const composer = this.composers.get(type);

    if (!composer) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_IMPLEMENTED, 422);
    }

    return composer;
  }

  /** Exposed so the AI service can read the same upstream state once. */
  async readUpstream(context: DocumentContext): Promise<UpstreamSnapshot> {
    return this.upstream.read(context.projectId, context.correlationId);
  }

  async currentDocument(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<DocumentDocument | null> {
    return this.repository.find(context.projectId, type);
  }

  /** The current feature rows, for the AI service's join. */
  async currentFeatures(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<readonly FeatureRow[]> {
    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      return [];
    }

    return (await this.repository.listFeatures(context.projectId, type, record.version)).map(
      toFeatureRow,
    );
  }

  async currentSections(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<readonly DocumentSection[]> {
    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      return [];
    }

    return (await this.repository.listSections(context.projectId, type, record.version)).map(
      toSection,
    );
  }

  /* ------------------------------------------------------------ internals */

  private assertImplemented(type: DocumentType): void {
    if (!isImplementedDocumentType(type)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_IMPLEMENTED, 422);
    }
  }

  /**
   * Synchronous: everything the lock check needs is already on the upstream
   * snapshot, which reads every document's state once per operation.
   */
  private assertUnlocked(type: DocumentType, upstream: UpstreamSnapshot): void {
    const lock = lockFor(
      type,
      {
        availableUpstream: this.availableUpstream(upstream),
        documentStates: upstream.documentStates,
      },
      IMPLEMENTED_DOCUMENT_TYPES,
    );

    if (lock) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_LOCKED, 422, undefined, {
        reason: lock.reason,
        summary: lock.summary,
      });
    }
  }

  private availableUpstream(upstream: UpstreamSnapshot): readonly UpstreamKind[] {
    const available: UpstreamKind[] = [];

    if (upstream.context.baseline) {
      available.push('REQUIREMENT_BASELINE');
    }

    if (upstream.context.stack) {
      available.push('TECHNOLOGY_STACK');
    }

    if (upstream.context.estimate) {
      available.push('ESTIMATION_SNAPSHOT');
    }

    return available;
  }

  private async expect(
    context: DocumentContext,
    type: DocumentType,
    expectedVersion: number,
  ): Promise<DocumentDocument> {
    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 404);
    }

    if (record.recordVersion !== expectedVersion) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 409, 'version_conflict');
    }

    return record;
  }

  /** A document that exists, is not issued, and matches the caller's version. */
  /**
   * The single gate every mutation goes through.
   *
   * Two conditions, and the difference between them matters.
   *
   * **Status** decides whether this document's content may change at all. An issued
   * document may not, ever.
   *
   * **The lock** decides whether the workflow has reached this document yet. A
   * document whose prerequisite has been withdrawn is not a document to patch: the
   * foundation it was built on is no longer agreed, so an edit would produce content
   * resting on nothing. Approving it is refused for the same reason, and generation
   * has always been.
   *
   * Reading is gated by neither, and that is deliberate. `read`, `version`,
   * `listVersions`, `compare` and the CSV go nowhere near this method. An approved or
   * issued document stays readable when the step above it is reopened, because
   * hiding a record somebody may have to produce — at the moment its context has
   * become contentious — is precisely when it must not disappear.
   */
  private async editableDocument(
    context: DocumentContext,
    type: DocumentType,
    expectedVersion: number,
  ): Promise<DocumentDocument> {
    this.assertImplemented(type);

    const record = await this.expect(context, type, expectedVersion);

    if (!isDocumentEditable(record.status as DocumentSnapshot['status'])) {
      throw new DocumentError(
        record.status === 'FINAL'
          ? DOCUMENT_ERROR_CODES.DOCUMENT_FINAL
          : DOCUMENT_ERROR_CODES.INVALID_STATUS_TRANSITION,
        409,
      );
    }

    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    this.assertUnlocked(type, upstream);

    return record;
  }

  /**
   * After any content change: an approved document returns to draft.
   *
   * Editing approved content silently would leave "approved" meaning nothing.
   * Downstream documents are told, because what they were built on has moved.
   */
  private async afterContentChange(
    context: DocumentContext,
    type: DocumentType,
    record: DocumentDocument,
    auditType: AuditEventType,
    metadata: Record<string, unknown>,
    changeType?: DocumentChangeType,
  ): Promise<void> {
    const wasApproved = record.status === 'APPROVED';

    /*
     * Every content change cuts a **new version**.
     *
     * The mutation has already been applied to the rows or sections carrying the
     * current version number, so the content is read back and re-keyed to the next
     * version. The version it came from keeps the snapshot it was archived with, which
     * is what makes "what did this say before I edited it?" answerable — and what makes
     * a comparison between two versions of a document possible at all.
     *
     * Re-keying rather than copying-then-mutating because the mutation paths are
     * many (a section, a row, a proposal, a correction) and each one would otherwise
     * have to remember to version itself. One place, applied to all of them.
     *
     * Row and section ids change with the version; the *semantic* keys — a criterion
     * key, a WBS outline number — travel with the content, which is what comparison
     * and traceability match on.
     */
    const content = await this.currentContent(context.projectId, record);
    const version = await this.repository.nextVersion(context.projectId, type);
    const now = new Date();

    /*
     * Re-read for the current `recordVersion`.
     *
     * Some callers — recording an exclusion, for one — update the record themselves
     * before handing over, which bumps `recordVersion`. Reusing the stale one made this
     * update match nothing while the content below was still re-keyed to the new
     * version: the document silently lost every row, because the record went on
     * pointing at a version that no longer held any.
     */
    const live = (await this.repository.find(context.projectId, type)) ?? record;

    const bumped = await this.repository.update(context.projectId, type, live.recordVersion, {
      version,
      ...(wasApproved ? { status: 'DRAFT' } : {}),
      supersedesVersion: record.version,
      /* The stored result described the previous content. */
      validation: null,
    });

    if (!bumped) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 409, 'version_conflict');
    }

    await this.repository.replaceSections(
      context.projectId,
      type,
      version,
      content.sections.map((section) => ({
        /* Identity carried forward: this is the same section, at a new version. */
        sectionId: section.sectionId,
        documentVersion: version,
        key: section.key,
        title: section.title,
        order: section.order,
        body: section.body,
        origin: section.origin,
        omittedReason: section.omittedReason ?? '',
        references: section.references,
        /* A pending proposal travels with the section: it is not yet decided. */
        ...(section.proposedBody !== undefined ? { proposedBody: section.proposedBody } : {}),
        ...(section.proposedAt ? { proposedAt: new Date(section.proposedAt) } : {}),
        createdAt: now,
      })),
    );

    await this.repository.replaceFeatures(
      context.projectId,
      type,
      version,
      content.features.map((feature) =>
        toFeatureRecord(feature, version, { featureId: feature.featureId }),
      ),
    );

    const rowKind = this.composerFor(type).rowKind;

    if (rowKind) {
      await this.repository.replaceRows(
        context.projectId,
        type,
        rowKind,
        version,
        content.rows.map((row, index) => ({
          /* Identity carried forward, so a caller's handle on this row still works. */
          rowId: row.rowId,
          documentVersion: version,
          order: index,
          origin: row.origin,
          attribution: row.attribution ?? '',
          payload: row.payload as Record<string, unknown>,
          proposed: row.proposed ?? null,
          ...(row.proposedAt ? { proposedAt: new Date(row.proposedAt) } : {}),
          references: row.references,
          excludedReason: row.excludedReason ?? '',
        })),
      );
    }

    await this.audit.record({
      type: auditType,
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, version, previousVersion: record.version, ...metadata },
    });

    const current = await this.repository.find(context.projectId, type);

    if (current) {
      await this.archive(
        context.projectId,
        current,
        await this.currentContent(context.projectId, current),
        undefined,
        undefined,
        changeType ? { changeType } : {},
      );
    }

    if (wasApproved) {
      await this.markDependentsOutdated(context, type);
    }
  }

  /**
   * Records that every document downstream of this one is no longer current.
   *
   * **Transitive**, along the whole chain. In a seven-document sequence a change
   * under Our Understanding reaches the Client Dependency Sheet through five
   * intermediaries, and telling only the next document along would be the
   * smallest true thing rather than the useful one.
   *
   * Three things this deliberately does not do.
   *
   * It does not **regenerate** anything. The content of a document somebody has
   * read, edited and possibly sent stays exactly as it is; what changes is what we
   * tell them about it.
   *
   * It does not **change a status**. Currentness is its own axis, so an approved
   * document stays approved and an issued one stays issued. Before that was true,
   * this method had to relabel an approved document `OUTDATED` and skip issued
   * ones entirely — which meant an issued document quietly stopped reporting that
   * its inputs had moved.
   *
   * It does not skip `FINAL`. An issued document is exactly the one where "the
   * project has changed since this was sent" most needs saying.
   */
  private async markDependentsOutdated(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<void> {
    for (const dependent of downstreamDocuments(type)) {
      const record = await this.repository.find(context.projectId, dependent);

      if (!record || record.status === 'NOT_STARTED') {
        continue;
      }

      const reasons = [
        ...record.outdatedReasons.filter((reason) => reason.documentType !== type),
        {
          cause: 'prerequisite_document_changed',
          documentType: type,
          summary: `${DOCUMENT_LABELS[type]} changed after this document was written.`,
        },
      ];

      await this.repository.touch(context.projectId, dependent, { outdatedReasons: reasons });

      await this.audit.record({
        type: 'DOCUMENT_OUTDATED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { documentType: dependent, cause: 'prerequisite_document_changed' },
      });
    }
  }

  private async prerequisiteVersions(
    projectId: string,
    type: DocumentType,
  ): Promise<Record<string, number>> {
    const versions: Record<string, number> = {};

    for (const prerequisite of DOCUMENT_DEPENDENCIES[type].documents) {
      const record = await this.repository.find(projectId, prerequisite);

      if (record) {
        versions[prerequisite] = record.version;
      }
    }

    return versions;
  }

  private upstreamFields(upstream: UpstreamSnapshot): Record<string, unknown> {
    return {
      ...(upstream.context.baseline
        ? {
            baselineId: upstream.context.baseline.id,
            baselineVersion: upstream.context.baseline.version,
          }
        : {}),
      ...(upstream.context.stack
        ? {
            stackSnapshotId: upstream.context.stack.id,
            stackVersion: upstream.context.stack.version,
          }
        : {}),
      ...(upstream.context.estimate
        ? {
            estimateSnapshotId: upstream.context.estimate.id,
            estimateVersion: upstream.context.estimate.version,
          }
        : {}),
      generator: {
        provider: 'deterministic',
        model: 'none',
        promptVersions: {},
        deterministicOnly: true,
      },
    };
  }

  private baselineCurrent(record: DocumentDocument, upstream: UpstreamSnapshot): boolean {
    const current = upstream.context.baseline?.version;

    return (
      upstream.baselineCurrent &&
      (record.baselineVersion === undefined || record.baselineVersion === current)
    );
  }

  /**
   * A section list for a new version, carrying protected sections forward.
   *
   * The rule that makes regeneration safe: a section a person wrote keeps its
   * body and its protected origin, and the freshly composed text becomes a
   * proposal beside it. Everything else takes the new content.
   */
  private mergeSections(
    content: ComposedContent,
    previous: readonly DocumentSection[],
    version: number,
    now: Date,
  ): Record<string, unknown>[] {
    const byKey = new Map(previous.map((section) => [section.key, section]));

    return content.sections.map((composed) => {
      const existing = byKey.get(composed.key);
      const keepUserText = existing !== undefined && !mayReplaceDirectly(existing);

      return {
        sectionId: DocumentsRepository.newId('dsc'),
        documentVersion: version,
        key: composed.key,
        title: composed.title,
        order: composed.order,
        body: keepUserText ? existing.body : composed.body,
        origin: keepUserText ? existing.origin : 'GENERATED',
        omittedReason: composed.omittedReason ?? '',
        references: composed.references as unknown as Record<string, unknown>[],
        proposedBody: keepUserText ? composed.body : '',
        ...(keepUserText ? { proposedAt: now } : {}),
        regenerationReason: '',
      };
    });
  }

  /**
   * Feature rows for a new version, carrying descriptive edits forward.
   *
   * Matched on the estimate unit behind the row, which is the row's identity —
   * a regenerated listing may reorder or reword, but the unit a row prices does
   * not change. Hours always come from the new composition, because they come
   * from the estimate and the estimate is the authority.
   */
  private buildFeatures(
    content: ComposedContent,
    previous: readonly FeatureRow[],
    version: number,
  ): Record<string, unknown>[] {
    const byUnit = new Map(
      previous
        .filter((row) => row.reviewStatus !== 'GENERATED')
        .map((row) => [row.estimateUnitIds.join('|'), row]),
    );

    return content.features.map((composed) => {
      const edited = byUnit.get(composed.estimateUnitIds.join('|'));

      return {
        featureId: DocumentsRepository.newId('ftr'),
        documentVersion: version,
        ...composed,
        ...(edited
          ? {
              module: edited.module,
              submodule: edited.submodule,
              screen: edited.screen,
              description: edited.description,
              notes: edited.notes,
              reviewStatus: edited.reviewStatus,
            }
          : {}),
        references: composed.references,
      };
    });
  }

  /**
   * Structured rows for a new version, keeping what a person decided.
   *
   * A row somebody edited or added is carried forward untouched, and a
   * regeneration that would have replaced it leaves a **proposal** beside it
   * instead — the same rule sections have, for the same reason: replacing it would
   * discard a decision, and nothing here can tell which words were the decision.
   *
   * Rows a person added from nothing survive regeneration entirely. Nothing
   * upstream produced them, so nothing upstream can supersede them.
   */
  private buildRows(
    content: ComposedContent,
    previous: readonly DocumentRow[],
    version: number,
    now: Date,
  ): Record<string, unknown>[] {
    /*
     * Matched on the identity the payload carries — the criterion or assumption key
     * — because a regenerated row is "the same row" when it is about the same
     * thing, not when it happens to land at the same index.
     */
    const protectedRows = previous.filter((row) => isRowProtected(row.origin));
    const byKey = new Map(
      protectedRows.map((row) => [
        DocumentsService.rowKey(row.payload as Record<string, unknown>),
        row,
      ]),
    );

    const rows: Record<string, unknown>[] = content.rows.map((composed) => {
      const existing = byKey.get(DocumentsService.rowKey(composed.payload));

      if (existing) {
        byKey.delete(DocumentsService.rowKey(composed.payload));

        return {
          rowId: DocumentsRepository.newId('drw'),
          documentVersion: version,
          order: composed.order,
          origin: existing.origin,
          attribution: existing.attribution ?? '',
          /* The person's version stays; the new one waits for a decision. */
          payload: existing.payload as Record<string, unknown>,
          proposed: composed.payload,
          proposedAt: now,
          references: composed.references,
          excludedReason: existing.excludedReason ?? '',
        };
      }

      return {
        rowId: DocumentsRepository.newId('drw'),
        documentVersion: version,
        order: composed.order,
        origin: 'GENERATED',
        attribution: '',
        payload: composed.payload,
        proposed: null,
        references: composed.references,
        excludedReason: '',
      };
    });

    /* Rows a person wrote that composition did not produce are kept as they are. */
    let order = rows.length;

    for (const orphan of byKey.values()) {
      rows.push({
        rowId: DocumentsRepository.newId('drw'),
        documentVersion: version,
        order: order++,
        origin: orphan.origin,
        attribution: orphan.attribution ?? '',
        payload: orphan.payload,
        proposed: null,
        references: orphan.references,
        excludedReason: orphan.excludedReason ?? '',
      });
    }

    return rows;
  }

  private async currentContent(
    projectId: string,
    record: DocumentDocument,
  ): Promise<StoredContent> {
    const [sections, features, rows] = await Promise.all([
      this.repository.listSections(projectId, record.type, record.version),
      this.repository.listFeatures(projectId, record.type, record.version),
      this.repository.listRows(projectId, record.type, record.version),
    ]);

    return {
      sections: sections.map(toSection),
      features: features.map(toFeatureRow),
      rows: rows.map(toRow),
      version: record.version,
      status: record.status as DocumentSnapshot['status'],
    };
  }

  /** Writes the content of a version into the immutable version collection. */
  private async archive(
    projectId: string,
    record: DocumentDocument,
    content: StoredContent,
    status?: DocumentSnapshot['status'],
    approvedAt?: Date,
    lineage: {
      readonly changeType?: DocumentChangeType;
      readonly restoredFromVersion?: number;
      readonly revisedFromVersion?: number;
    } = {},
  ): Promise<void> {
    const existing = await this.repository.findVersion(projectId, record.type, record.version);
    const payload = {
      status: status ?? record.status,
      /*
       * Lineage is written once and never overwritten by a later touch of the same
       * version. "This came back from version 4" is a fact about how the version was
       * created; a subsequent edit to the same working version does not unmake it.
       */
      ...(lineage.changeType && !existing?.changeType ? { changeType: lineage.changeType } : {}),
      ...(lineage.restoredFromVersion !== undefined && existing?.restoredFromVersion === undefined
        ? { restoredFromVersion: lineage.restoredFromVersion }
        : {}),
      ...(lineage.revisedFromVersion !== undefined && existing?.revisedFromVersion === undefined
        ? { revisedFromVersion: lineage.revisedFromVersion }
        : {}),
      ...(existing?.actor ? {} : { actor: 'USER' }),
      sections: content.sections as unknown as Record<string, unknown>[],
      features: content.features as unknown as Record<string, unknown>[],
      rows: content.rows as unknown as Record<string, unknown>[],
      validation: record.validation,
      regenerationReason: record.regenerationReason,
      ...(record.baselineVersion !== undefined ? { baselineVersion: record.baselineVersion } : {}),
      ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
      ...(record.estimateVersion !== undefined ? { estimateVersion: record.estimateVersion } : {}),
      ...(approvedAt ? { approvedAt } : {}),
    };

    if (existing) {
      await this.repository.updateVersion(projectId, record.type, record.version, payload);
      return;
    }

    await this.repository.createVersion({
      versionId: DocumentsRepository.newId('dvr'),
      projectId,
      type: record.type,
      version: record.version,
      ...payload,
    });
  }

  /**
   * The document plus everything computed from it.
   *
   * Recomputed on every read, as Phase 6 does with the estimate: outdatedness,
   * coverage, reconciliation and blockers are all functions of stored data and
   * the current upstream state, and storing them without recomputing is how a
   * stale "everything is fine" survives an upstream change.
   */
  private async assemble(
    context: DocumentContext,
    record: DocumentDocument,
  ): Promise<DocumentSnapshot> {
    const type = record.type as DocumentType;
    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const content = await this.currentContent(context.projectId, record);
    const composer = this.composerFor(type);

    const reasons = this.outdatedFor(record, upstream);

    const excluded = record.exclusions.map((entry) => entry.requirementId);

    /*
     * Feature coverage and effort reconciliation belong to Feature Listing alone —
     * they are about hours. Every other list document has its own assessment, and
     * each is computed only for the document it describes rather than for anything
     * that happens to be a list.
     */
    const coverage =
      type === 'FEATURE_LISTING'
        ? this.featureListing.coverageFor(upstream.context, content.features, excluded)
        : null;
    const reconciliation =
      type === 'FEATURE_LISTING'
        ? this.featureListing.reconciliationFor(upstream.context, content.features)
        : null;

    const validationInput = {
      context: upstream.context,
      sections: content.sections.map((section) => ({
        key: section.key,
        body: section.body,
        references: section.references.map((reference) => reference.id),
      })),
      features: content.features,
      rows: content.rows,
      excludedRequirementIds: excluded,
      baselineCurrent: upstream.baselineCurrent,
    };

    const criteriaCoverage =
      type === 'ACCEPTANCE_CRITERIA' ? this.acceptanceCriteria.coverageFor(validationInput) : null;
    const assumptionSummary =
      type === 'ASSUMPTIONS' ? this.assumptions.summaryFor(validationInput) : null;
    const scopeReconciliation =
      type === 'STATEMENT_OF_WORK' ? this.statementOfWork.reconciliationFor(validationInput) : null;
    const wbsReconciliation =
      type === 'WORK_BREAKDOWN_STRUCTURE'
        ? this.workBreakdown.reconciliationFor(validationInput)
        : null;
    const wbsCoverage =
      type === 'WORK_BREAKDOWN_STRUCTURE' ? this.workBreakdown.coverageFor(validationInput) : null;
    const dependencySummary =
      type === 'CLIENT_DEPENDENCY_SHEET'
        ? this.clientDependencies.summaryFor(validationInput)
        : null;

    /*
     * The reverse view of the dependency relationship, derived on every read.
     *
     * The sheet owns the link in its own `wbsIds`; this reads it backwards so somebody
     * on a work package can see what it waits for. Derived rather than stored, because
     * storing it would mean generating document 7 had to rewrite document 6 — including
     * an issued one — and an issued document is history. It also cannot drift: there is
     * no second copy to disagree with the sheet.
     */
    const reverseDependencies =
      type === 'WORK_BREAKDOWN_STRUCTURE'
        ? await this.reverseDependencyLinks(context, upstream)
        : null;

    const unapproved = DOCUMENT_DEPENDENCIES[type].documents.filter((prerequisite) => {
      const state = upstream.documentStates[prerequisite];

      return state !== undefined && !isAuthoritativeState(state);
    });

    const blockers = calculateDocumentBlockers({
      generated:
        content.sections.length > 0 ||
        content.features.length > 0 ||
        content.rows.length > 0 ||
        composer.mayBeEmpty === true,
      sections: content.sections,
      pendingFeatureIds: DocumentsService.featuresAwaitingDecision(content.features),
      pendingRowIds: rowsAwaitingDecision(content.rows),
      unattributedRowIds: content.rows.filter(rowNeedsAttribution).map((row) => row.rowId),
      requiredSectionKeys: composer.requiredSectionKeys,
      validation: record.validation as unknown as DocumentValidation | null,
      outdatedReasons: reasons,
      coverage,
      reconciliation,
      criteriaCoverage,
      assumptionSummary,
      scopeReconciliation,
      wbsReconciliation,
      wbsCoverage,
      unapprovedPrerequisites: unapproved,
    });

    /*
     * The status is what somebody decided; the currentness is what the world did.
     * Neither is written over the other. An issued document stays `FINAL` and
     * says `OUTDATED` beside it — relabelling it would make the history lie about
     * what was sent, and hiding the staleness would let a reader quote a document
     * the project has moved past.
     *
     * Currentness is derived on every read rather than written by a background
     * job, so it cannot itself be stale.
     */
    return toDocumentSnapshot(record, content, {
      status: record.status as DocumentSnapshot['status'],
      currentness: currentnessFrom(reasons),
      blockers,
      outdatedReasons: reasons,
      coverage,
      reconciliation,
      rows: content.rows,
      criteriaCoverage,
      assumptionSummary,
      scopeReconciliation,
      wbsReconciliation,
      wbsCoverage,
      dependencySummary,
      reverseDependencies,
    });
  }

  /**
   * Client dependencies that name each work package, read from the sheet as it stands.
   *
   * The sheet is read whatever state it is in — draft, approved, issued or stale — and
   * its status and currentness travel with every entry. A reverse link into a stale
   * sheet is still useful, and a reader has to be told it is stale or the breakdown
   * appears to make a current claim it cannot support.
   */
  private async reverseDependencyLinks(
    context: DocumentContext,
    upstream: UpstreamSnapshot,
  ): Promise<ReverseDependencyIndex | null> {
    const sheet = await this.repository.find(context.projectId, 'CLIENT_DEPENDENCY_SHEET');

    if (!sheet) {
      return null;
    }

    const rows = await this.repository.listRows(
      context.projectId,
      'CLIENT_DEPENDENCY_SHEET',
      sheet.version,
    );

    const state = upstream.documentStates.CLIENT_DEPENDENCY_SHEET;

    return reverseDependencyIndex({
      dependencies: rows
        .filter((row) => !row.excludedReason)
        .map((row) => row.payload as unknown as ClientDependency)
        .map((dependency) => ({
          dependencyKey: dependency.dependencyKey,
          dependency: dependency.dependency,
          category: dependency.category,
          status: dependency.status,
          blocking: dependency.blocking,
          wbsIds: dependency.wbsIds,
          satisfied: isDependencySatisfied(dependency.status),
        })),
      sheetVersion: sheet.version,
      sheetStatus: sheet.status,
      sheetCurrentness: state?.currentness ?? 'CURRENT',
    });
  }

  /**
   * Every reason a document is out of date.
   *
   * One derivation, called by both the list and the detail — a card saying
   * "approved" beside a document that reports itself out of date when opened is
   * the kind of disagreement nobody trusts afterwards.
   */
  private outdatedFor(
    record: DocumentDocument,
    upstream: UpstreamSnapshot,
  ): DocumentSnapshot['outdatedReasons'] {
    return [
      ...documentOutdatedReasonsFor(record, this.authorityVersions(upstream)),
    ] as DocumentSnapshot['outdatedReasons'];
  }

  /** Today's authoritative versions, in the shape the currentness check wants. */
  private authorityVersions(upstream: UpstreamSnapshot): AuthorityVersions {
    return {
      ...(upstream.context.baseline ? { baselineVersion: upstream.context.baseline.version } : {}),
      ...(upstream.context.stack ? { stackVersion: upstream.context.stack.version } : {}),
      ...(upstream.context.estimate ? { estimateVersion: upstream.context.estimate.version } : {}),
      baselineCurrent: upstream.baselineCurrent,
    };
  }

  /**
   * A row's own identity — `AC-001`, `AS-004` — from its payload.
   *
   * Rows are matched across regenerations on this rather than on position: a
   * regenerated row is "the same row" when it is about the same thing, not when it
   * happens to land at the same index.
   */
  private static rowKey(payload: Record<string, unknown>): string {
    const candidate =
      payload.criterionKey ?? payload.assumptionKey ?? payload.wbsId ?? payload.dependencyKey;

    return typeof candidate === 'string' ? candidate : '';
  }

  /**
   * Store a model's suggestions as candidates.
   *
   * The only path from an inference result to an assumption row, and every
   * authoritative field is supplied here by `candidateToAssumption` rather than by
   * the model: `DRAFT`, provenance `MODEL_SUGGESTED`, no owner, no confirmation.
   * A candidate is appended rather than replacing anything, because a suggestion
   * should never displace an assumption somebody has stood behind.
   */
  async addAssumptionCandidates(
    context: DocumentContext,
    type: DocumentType,
    candidates: readonly AssumptionCandidate[],
    expectedVersion: number,
    runId: string,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, expectedVersion);
    const composer = this.composerFor(type);

    if (!composer.rowKind) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422);
    }

    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const byKey = new Map(
      upstream.context.requirements.map((requirement) => [requirement.key, requirement]),
    );

    const existing = await this.repository.listRows(context.projectId, type, record.version);
    const keys = existing.map((row) => DocumentsService.rowKey(row.payload));

    /* Deduplicated against what is already here, so asking twice is harmless. */
    const seen = new Set(
      existing.map((row) =>
        payloadText(row.payload, 'statement').toLowerCase().replace(/\s+/g, ' ').trim(),
      ),
    );

    const rows: Record<string, unknown>[] = [];

    for (const candidate of candidates) {
      const fingerprint = candidate.statement.toLowerCase().replace(/\s+/g, ' ').trim();

      if (seen.has(fingerprint)) {
        continue;
      }

      seen.add(fingerprint);

      const requirements = candidate.requirementKeys
        .map((key) => byKey.get(key))
        .filter((requirement) => requirement !== undefined);

      const assumption = candidateToAssumption(
        candidate,
        nextAssumptionKey([
          ...keys,
          ...rows.map((row) => DocumentsService.rowKey(row.payload as Record<string, unknown>)),
        ]),
        requirements.map((requirement) => requirement.key),
      );

      rows.push({
        rowId: DocumentsRepository.newId('drw'),
        order: existing.length + rows.length,
        origin: 'GENERATED',
        attribution: '',
        payload: assumptionSchema.parse(assumption),
        proposed: null,
        references: requirements.map(requirementReference),
        excludedReason: '',
      });
    }

    await this.repository.insertRows(
      context.projectId,
      type,
      composer.rowKind,
      record.version,
      rows,
    );

    await this.audit.record({
      type: 'ASSUMPTION_CANDIDATE_CREATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      /* Counts and the run, never the statements themselves. */
      metadata: { documentType: type, candidateCount: rows.length, runId },
    });

    return this.reload(context, type);
  }

  /* ------------------------------------------------------ structured rows */

  /**
   * Edit one row's own fields.
   *
   * The payload is parsed by the document's own schema before anything is stored,
   * so an acceptance criterion cannot acquire a field nobody defined and an
   * assumption cannot acquire a status by being edited. Editing marks the row as
   * the person's, which is what protects it from the next regeneration.
   *
   * Two things a person may not do by editing: change an assumption's `status`,
   * `provenance` or `confirmedBy` — those move only through confirm, reject and
   * settle, where the application records who did it — and cite a requirement or
   * feature that does not exist.
   */
  async updateRow(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: EditRow,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);

    const merged = { ...row.payload, ...(request.payload as Record<string, unknown>) };
    const payload = this.parseRowPayload(type, merged, row.payload);

    /*
     * A dependency may only point at work that exists in *this* project's breakdown.
     *
     * Checked here rather than only in validation because this is the field that makes
     * the reverse view work: a dangling id would produce a navigation link to nothing,
     * and an id belonging to another project would be a cross-project reference. The
     * breakdown is read through the caller's own session, so an id from elsewhere is
     * simply not found — the same answer as one that never existed.
     */
    if (type === 'CLIENT_DEPENDENCY_SHEET') {
      await this.assertKnownWbsIds(context, payload);
    }

    const references = request.referenceIds
      ? await this.verifiedReferences(context, type, request.referenceIds)
      : (row.references as unknown as DocumentReference[]);

    await this.repository.updateRow(context.projectId, rowId, record.version, {
      payload,
      references,
      origin: row.origin === 'USER_DEFINED' ? 'USER_DEFINED' : 'USER_EDITED',
      ...(request.attribution !== undefined ? { attribution: request.attribution } : {}),
    });

    await this.afterContentChange(
      context,
      type,
      record,
      'DOCUMENT_EDITED',
      {
        rowId,
        fields: Object.keys(request.payload ?? {}),
      },
      'ROW_EDITED',
    );

    return this.reload(context, type);
  }

  /**
   * Add a row by hand.
   *
   * Marked `USER_DEFINED`, and the attribution is required by the request schema
   * rather than checked afterwards — a criterion or an assumption nobody can trace
   * is exactly what should have to be justified out loud, and asking at the moment
   * of writing is easier than asking at approval.
   */
  async addRow(
    context: DocumentContext,
    type: DocumentType,
    request: AddRow,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const composer = this.composerFor(type);

    if (!composer.rowKind) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422);
    }

    const existing = await this.repository.listRows(context.projectId, type, record.version);
    const payload = this.parseRowPayload(
      type,
      this.withNextKey(type, request.payload as Record<string, unknown>, existing),
      null,
    );

    /* A hand-added dependency may only point at work that exists here, as on edit. */
    if (type === 'CLIENT_DEPENDENCY_SHEET') {
      await this.assertKnownWbsIds(context, payload);
    }

    const references = await this.verifiedReferences(context, type, request.referenceIds ?? []);

    await this.repository.insertRows(context.projectId, type, composer.rowKind, record.version, [
      {
        rowId: DocumentsRepository.newId('drw'),
        order: existing.length,
        origin: 'USER_DEFINED',
        attribution: request.attribution,
        payload,
        proposed: null,
        references,
        excludedReason: '',
      },
    ]);

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      rowAdded: true,
      origin: 'USER_DEFINED',
    });

    return this.reload(context, type);
  }

  /** Record that a row is deliberately not part of this document, with a reason. */
  async excludeRow(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: ExcludeRow,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    await this.expectRow(context.projectId, type, record.version, rowId);

    await this.repository.updateRow(context.projectId, rowId, record.version, {
      excludedReason: request.reason,
    });

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      rowId,
      excluded: true,
    });

    return this.reload(context, type);
  }

  /**
   * Take a row out of the working document.
   *
   * Removal, not exclusion. An exclusion stays on the sheet with its reason, which is
   * what a client should see for scope deliberately left out; a removal is for a row
   * that should not have been there at all.
   *
   * History is untouched: every archived version holds its own copy of the rows it
   * had, so the versions that contained this row still contain it, and the diff between
   * them shows exactly when it went. If the row was the only thing covering an approved
   * requirement, the coverage check notices on the next validation — removal is not a
   * way to make a blocker disappear.
   */
  async removeRow(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: RemoveRow,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);
    const rowKey = DocumentsService.rowKey(row.payload);

    await this.repository.deleteRow(context.projectId, rowId, record.version);

    await this.afterContentChange(
      context,
      type,
      record,
      'DOCUMENT_ROW_REMOVED',
      { rowId, rowKey, reason: request.reason },
      'ROW_REMOVED',
    );

    return this.reload(context, type);
  }

  /**
   * Rewrite selected rows, and nothing else.
   *
   * `rowIds` selects rows directly; `group` selects every row in one module (for
   * acceptance criteria) or one category (for assumptions). Rows outside the
   * selection are carried forward untouched, so a targeted rewrite cannot disturb
   * the rest of the document.
   *
   * A row a person edited or wrote gets a **proposal** rather than a replacement.
   */
  async regenerateRows(
    context: DocumentContext,
    type: DocumentType,
    selection: { readonly rowIds?: readonly string[]; readonly group?: string },
    expectedVersion: number,
    named: ReadonlyMap<string, Record<string, unknown>>,
    reason?: string,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, expectedVersion);
    const composer = this.composerFor(type);

    if (!composer.rowKind) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422);
    }

    const stored = await this.repository.listRows(context.projectId, type, record.version);
    const selected = this.selectRows(type, stored, selection);

    if (selected.length === 0) {
      throw new DocumentError(
        selection.group !== undefined
          ? DOCUMENT_ERROR_CODES.CATEGORY_NOT_FOUND
          : DOCUMENT_ERROR_CODES.ROW_NOT_FOUND,
        404,
      );
    }

    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const composed = composer.compose(upstream.context);
    const now = new Date();

    const selectedIds = new Set(selected.map((row) => row.rowId));
    const version = await this.repository.nextVersion(context.projectId, type);

    /* Everything is carried forward; only the selected rows change. */
    const rows = stored.map((row, index) => {
      const key = DocumentsService.rowKey(row.payload);
      const replacement =
        named.get(row.rowId) ??
        composed.rows.find((candidate) => DocumentsService.rowKey(candidate.payload) === key)
          ?.payload;

      if (!selectedIds.has(row.rowId) || replacement === undefined) {
        return {
          rowId: DocumentsRepository.newId('drw'),
          documentVersion: version,
          order: index,
          origin: row.origin,
          attribution: row.attribution ?? '',
          payload: row.payload,
          proposed: row.proposed ?? null,
          ...(row.proposedAt ? { proposedAt: row.proposedAt } : {}),
          references: row.references,
          excludedReason: row.excludedReason ?? '',
        };
      }

      /* Whatever a document allows a rewrite to touch, and never more. */
      const rewritten = this.parseRowPayload(
        type,
        { ...row.payload, ...this.rewritableFields(type, replacement) },
        row.payload,
      );

      const protectedRow = isRowProtected(row.origin as DocumentRow['origin']);

      return {
        rowId: DocumentsRepository.newId('drw'),
        documentVersion: version,
        order: index,
        origin: row.origin,
        attribution: row.attribution ?? '',
        payload: protectedRow ? row.payload : rewritten,
        proposed: protectedRow ? rewritten : null,
        ...(protectedRow ? { proposedAt: now } : {}),
        references: row.references,
        excludedReason: row.excludedReason ?? '',
      };
    });

    const previous = await this.currentContent(context.projectId, record);
    await this.archive(context.projectId, record, previous);

    await this.repository.update(context.projectId, type, record.recordVersion, {
      version,
      status: 'DRAFT',
      supersedesVersion: record.version,
      regenerationReason: reason ?? 'Rewrote selected entries',
      validation: null,
    });

    await this.repository.replaceSections(
      context.projectId,
      type,
      version,
      previous.sections.map((section) => ({
        sectionId: DocumentsRepository.newId('dsc'),
        documentVersion: version,
        key: section.key,
        title: section.title,
        order: section.order,
        body: section.body,
        origin: section.origin,
        omittedReason: section.omittedReason ?? '',
        references: section.references,
        proposedBody: section.proposedBody ?? '',
        updatedAt: now,
      })),
    );

    await this.repository.replaceRows(context.projectId, type, composer.rowKind, version, rows);

    const current = await this.repository.find(context.projectId, type);

    if (current) {
      await this.archive(
        context.projectId,
        current,
        await this.currentContent(context.projectId, current),
        undefined,
        undefined,
        { changeType: 'TARGETED_REGENERATION' },
      );
    }

    await this.audit.record({
      type: 'DOCUMENT_ROW_REGENERATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: type,
        version,
        rowCount: selected.length,
        ...(selection.group !== undefined ? { group: selection.group } : {}),
      },
    });

    return this.reload(context, type);
  }

  /** Decide what happens to a row's suggested rewrite. */
  async resolveRowProposal(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: ResolveRowProposal,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);

    if (!row.proposed) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.NO_ROW_PROPOSAL, 422);
    }

    const chosen =
      request.decision === 'KEEP_CURRENT'
        ? row.payload
        : request.decision === 'ACCEPT_GENERATED_REVISION'
          ? row.proposed
          : {
              ...row.proposed,
              ...this.rewritableFields(type, (request.payload ?? {}) as Record<string, unknown>),
            };

    await this.repository.updateRow(
      context.projectId,
      rowId,
      record.version,
      {
        payload: this.parseRowPayload(type, chosen, row.payload),
        proposed: null,
      },
      ['proposedAt'],
    );

    await this.afterContentChange(
      context,
      type,
      record,
      'DOCUMENT_PROPOSAL_RESOLVED',
      {
        rowId,
        decision: request.decision,
      },
      'PROPOSAL_ACCEPTED',
    );

    return this.reload(context, type);
  }

  /* --------------------------------------------------------- assumptions */

  /**
   * Stand behind an assumption.
   *
   * The only path from candidate to authority, and it takes a person. They say what
   * it rests on, and the application — not the model, not the request — sets
   * `status`, `confirmedBy` and `confirmedAt`.
   */
  async confirmAssumption(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: ConfirmAssumption,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);
    const assumption = row.payload as unknown as Assumption;

    if (!canTransitionAssumption(assumption.status, 'CONFIRMED')) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.ASSUMPTION_NOT_CONFIRMABLE, 409);
    }

    const payload = this.parseRowPayload(
      type,
      {
        ...row.payload,
        status: 'CONFIRMED',
        provenance: request.provenance,
        basis: request.basis,
        ...(request.owner !== undefined ? { owner: request.owner } : {}),
        ...(request.validateBy !== undefined ? { validateBy: request.validateBy } : {}),
        confirmedBy: 'USER',
        confirmedAt: new Date().toISOString(),
      },
      row.payload,
      { allowStatusChange: true },
    );

    await this.repository.updateRow(context.projectId, rowId, record.version, { payload });

    await this.afterContentChange(context, type, record, 'ASSUMPTION_CONFIRMED', {
      assumptionKey: assumption.assumptionKey,
      provenance: request.provenance,
    });

    return this.reload(context, type);
  }

  /** Turn an assumption down. Kept on the record with the reason. */
  async rejectAssumption(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: RejectAssumption,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);
    const assumption = row.payload as unknown as Assumption;

    if (!canTransitionAssumption(assumption.status, 'REJECTED')) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.ASSUMPTION_NOT_CONFIRMABLE, 409);
    }

    const payload = this.parseRowPayload(
      type,
      {
        ...row.payload,
        status: 'REJECTED',
        rejectedReason: request.reason,
      },
      row.payload,
      { allowStatusChange: true },
    );

    await this.repository.updateRow(context.projectId, rowId, record.version, { payload });

    await this.afterContentChange(context, type, record, 'ASSUMPTION_REJECTED', {
      assumptionKey: assumption.assumptionKey,
    });

    return this.reload(context, type);
  }

  /** Record that a confirmed assumption turned out to be true, or did not. */
  async settleAssumption(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: SettleAssumption,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);
    const assumption = row.payload as unknown as Assumption;

    if (!canTransitionAssumption(assumption.status, request.outcome)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.ASSUMPTION_NOT_CONFIRMABLE, 409);
    }

    const payload = this.parseRowPayload(
      type,
      {
        ...row.payload,
        status: request.outcome,
        notes: [assumption.notes, request.note].filter(Boolean).join('\n'),
      },
      row.payload,
      { allowStatusChange: true },
    );

    await this.repository.updateRow(context.projectId, rowId, record.version, { payload });

    await this.afterContentChange(
      context,
      type,
      record,
      request.outcome === 'VALIDATED' ? 'ASSUMPTION_VALIDATED' : 'ASSUMPTION_INVALIDATED',
      { assumptionKey: assumption.assumptionKey },
    );

    return this.reload(context, type);
  }

  /* -------------------------------------------------- client dependencies */

  /**
   * The dependency lifecycle, as three deliberate acts.
   *
   * Each is a separate method for the same reason the statuses are separate values:
   * asking for something, receiving it and finding that it works are three different
   * events, and a project that treats them as one believes it is unblocked from the
   * moment an email arrives.
   *
   * All three go through `editableDocument`, so an approved or issued sheet refuses
   * them — the lifecycle is content, and content in an issued document is history.
   */
  async requestDependency(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: RequestDependency,
  ): Promise<DocumentSnapshot> {
    return this.moveDependency(context, type, rowId, request.expectedVersion, 'REQUESTED', {
      requestedAt: new Date().toISOString(),
      ...(request.note ? { remarks: request.note } : {}),
    });
  }

  /** Record that it turned up. Explicitly *not* that it is usable. */
  async receiveDependency(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: ReceiveDependency,
  ): Promise<DocumentSnapshot> {
    return this.moveDependency(
      context,
      type,
      rowId,
      request.expectedVersion,
      request.partial ? 'PARTIALLY_RECEIVED' : 'RECEIVED',
      {
        receivedAt: new Date().toISOString(),
        ...(request.note ? { remarks: request.note } : {}),
      },
    );
  }

  /**
   * Record what checking it showed.
   *
   * The note is required by the contract in both directions. "Accepted" with nothing
   * behind it is indistinguishable from "it arrived and nobody looked", which is the
   * failure this whole document is arranged to prevent.
   */
  async validateDependency(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    request: ValidateDependency,
  ): Promise<DocumentSnapshot> {
    return this.moveDependency(context, type, rowId, request.expectedVersion, request.outcome, {
      validatedAt: new Date().toISOString(),
      validationNote: request.note,
    });
  }

  private async moveDependency(
    context: DocumentContext,
    type: DocumentType,
    rowId: string,
    expectedVersion: number,
    to: DependencyStatus,
    changes: Record<string, unknown>,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, expectedVersion);
    const row = await this.expectRow(context.projectId, type, record.version, rowId);
    const dependency = row.payload as ClientDependency;

    if (!canTransitionDependency(dependency.status, to)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DEPENDENCY_TRANSITION_INVALID, 409, undefined, {
        from: dependency.status,
        to,
      });
    }

    const payload = this.parseRowPayload(
      type,
      { ...row.payload, ...changes, status: to },
      row.payload,
      { allowStatusChange: true },
    );

    await this.repository.updateRow(context.projectId, rowId, record.version, { payload });

    await this.afterContentChange(context, type, record, 'CLIENT_DEPENDENCY_STATUS_CHANGED', {
      /*
       * The key and the states, never the row's text. A dependency's wording can name
       * a system, an environment or a person, and audit metadata is read by people who
       * were not cleared for the document.
       */
      dependencyKey: dependency.dependencyKey,
      from: dependency.status,
      to,
      credentialsRequired: dependency.credentialsRequired,
    });

    return this.reload(context, type);
  }

  /**
   * Every WBS id a dependency names must be in this project's current breakdown.
   *
   * The breakdown is fetched for the session's own project, so an id from another
   * project cannot resolve — cross-project references are refused by the same check that
   * refuses a typo, and neither is told apart in the response.
   */
  private async assertKnownWbsIds(
    context: DocumentContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const wbsIds = (payload.wbsIds as string[] | undefined) ?? [];

    if (wbsIds.length === 0) {
      return;
    }

    const breakdown = await this.repository.find(context.projectId, 'WORK_BREAKDOWN_STRUCTURE');

    const known = breakdown
      ? new Set(
          (
            await this.repository.listRows(
              context.projectId,
              'WORK_BREAKDOWN_STRUCTURE',
              breakdown.version,
            )
          ).map((row) => (row.payload as unknown as WorkPackage).wbsId),
        )
      : new Set<string>();

    const unknown = wbsIds.filter((id) => !known.has(id));

    if (unknown.length > 0) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.UNKNOWN_WBS_REFERENCE, 422, undefined, {
        unknown: unknown.slice(0, 20),
      });
    }
  }

  /* ----------------------------------------------------- row internals */

  private async expectRow(
    projectId: string,
    type: DocumentType,
    version: number,
    rowId: string,
  ): Promise<DocumentRowDocument> {
    const row = await this.repository.findRow(projectId, rowId, version);

    if (row?.type !== type || row.documentVersion !== version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.ROW_NOT_FOUND, 404);
    }

    return row;
  }

  /**
   * Parse a row payload against the schema of the document it belongs to.
   *
   * The one gate between a request and storage. `allowStatusChange` is false for
   * every ordinary edit, so an assumption's status, provenance and confirmation
   * cannot be set by editing the row — they move only through the operations that
   * record who did it. A request that tries is refused rather than silently
   * ignored, because silently ignoring it would look like it worked.
   */
  private parseRowPayload(
    type: DocumentType,
    candidate: Record<string, unknown>,
    previous: Record<string, unknown> | null,
    options: { readonly allowStatusChange?: boolean } = {},
  ): Record<string, unknown> {
    if (type === 'ASSUMPTIONS' && previous && !options.allowStatusChange) {
      const guarded = ['status', 'provenance', 'confirmedBy', 'confirmedAt'] as const;

      for (const field of guarded) {
        if (
          candidate[field] !== undefined &&
          JSON.stringify(candidate[field]) !== JSON.stringify(previous[field])
        ) {
          throw new DocumentError(DOCUMENT_ERROR_CODES.ASSUMPTION_PROVENANCE_REQUIRED, 422);
        }
      }
    }

    /*
     * The work breakdown's schedule is a copy of the approved plan, so hand-editing a
     * start day here would produce a document that quietly disagrees with the estimate
     * somebody signed. Validation would catch it, but refusing the write says where to
     * make the change instead of leaving an unapprovable document behind.
     *
     * Hours are deliberately *not* guarded. Splitting a task or moving work between
     * roles is a legitimate correction, and `reconcileWbsEffort` is the check: the
     * document simply cannot be approved until the parts add up to what was approved.
     */
    if (type === 'WORK_BREAKDOWN_STRUCTURE' && previous) {
      const derived = [
        'relativeStartDay',
        'relativeFinishDay',
        'actualStartDate',
        'actualFinishDate',
        'workingDuration',
        'calendarDuration',
        'slackDays',
        'onCriticalPath',
      ] as const;

      for (const field of derived) {
        if (
          candidate[field] !== undefined &&
          JSON.stringify(candidate[field]) !== JSON.stringify(previous[field])
        ) {
          throw new DocumentError(DOCUMENT_ERROR_CODES.SCHEDULE_NOT_EDITABLE_HERE, 422);
        }
      }
    }

    /*
     * A dependency's lifecycle moves through its own actions, which record who decided
     * and when. Letting an ordinary edit set `status: ACCEPTED` would put the project's
     * "we are unblocked" signal in a text field with no timestamp behind it.
     */
    if (type === 'CLIENT_DEPENDENCY_SHEET' && previous && !options.allowStatusChange) {
      const guarded = ['status', 'requestedAt', 'receivedAt', 'validatedAt'] as const;

      for (const field of guarded) {
        if (
          candidate[field] !== undefined &&
          JSON.stringify(candidate[field]) !== JSON.stringify(previous[field])
        ) {
          throw new DocumentError(DOCUMENT_ERROR_CODES.DEPENDENCY_STATUS_NOT_EDITABLE_HERE, 422);
        }
      }
    }

    const schema =
      type === 'ACCEPTANCE_CRITERIA'
        ? acceptanceCriterionSchema
        : type === 'WORK_BREAKDOWN_STRUCTURE'
          ? workPackageSchema
          : type === 'CLIENT_DEPENDENCY_SHEET'
            ? clientDependencySchema
            : assumptionSchema;

    const parsed = schema.safeParse(candidate);

    if (!parsed.success) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422, undefined, {
        problems: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 20),
      });
    }

    /*
     * The last gate before a credential could enter an immutable version. Checked here
     * rather than only in validation, because validation is advisory until approval and
     * this must never be stored at all — a version, once issued, cannot be recalled.
     */
    if (type === 'CLIENT_DEPENDENCY_SHEET') {
      const secrets = secretsInDependency(parsed.data as ClientDependency);

      if (secrets.length > 0) {
        throw new DocumentError(DOCUMENT_ERROR_CODES.CREDENTIAL_VALUE_REFUSED, 422, undefined, {
          /* What it looked like, never the text that triggered it. */
          kinds: secrets,
        });
      }
    }

    return parsed.data;
  }

  /**
   * The fields a rewrite may touch.
   *
   * Descriptive wording only. An acceptance criterion's requirement and feature
   * links stay as they are, because changing what a criterion is *about* is a scope
   * decision rather than a wording one; an assumption's status and provenance stay,
   * for the reason above.
   */
  private rewritableFields(
    type: DocumentType,
    candidate: Record<string, unknown>,
  ): Record<string, unknown> {
    const allowed =
      type === 'ACCEPTANCE_CRITERIA'
        ? ['module', 'submodule', 'screen', 'actor', 'given', 'when', 'then', 'rule', 'notes']
        : type === 'WORK_BREAKDOWN_STRUCTURE'
          ? /*
             * Wording only. Not the hours, not the schedule, not the hierarchy: a model
             * rewriting what a task *is called* is useful, and a model moving a task or
             * changing its days would be re-planning the project in a text field.
             */
            ['task', 'description', 'deliverable', 'notes']
          : type === 'CLIENT_DEPENDENCY_SHEET'
            ? /*
               * Wording and expectations. Never the owner, the due date, the status or
               * the priority — those commit a person or unblock work, and a rewrite is
               * not the place for either.
               */
              [
                'dependency',
                'description',
                'purpose',
                'expectedFormat',
                'impactIfDelayed',
                'remarks',
              ]
            : [
                'statement',
                'category',
                'impact',
                'impactAreas',
                'impactIfFalse',
                'validationNeeded',
                'notes',
              ];

    return Object.fromEntries(
      Object.entries(candidate).filter(([field]) => allowed.includes(field)),
    );
  }

  /** Rows a targeted regeneration is aimed at. */
  private selectRows(
    type: DocumentType,
    rows: readonly DocumentRowDocument[],
    selection: { readonly rowIds?: readonly string[]; readonly group?: string },
  ): readonly DocumentRowDocument[] {
    if (selection.rowIds && selection.rowIds.length > 0) {
      const wanted = new Set(selection.rowIds);

      return rows.filter((row) => wanted.has(row.rowId));
    }

    if (selection.group === undefined) {
      return [];
    }

    /* A module for acceptance criteria; a category for assumptions. */
    const field = type === 'ACCEPTANCE_CRITERIA' ? 'module' : 'category';

    return rows.filter((row) => row.payload[field] === selection.group);
  }

  /** The next free key for a hand-added row. */
  private withNextKey(
    type: DocumentType,
    payload: Record<string, unknown>,
    existing: readonly DocumentRowDocument[],
  ): Record<string, unknown> {
    const keys = existing.map((row) => DocumentsService.rowKey(row.payload));

    if (type === 'ACCEPTANCE_CRITERIA') {
      return { ...payload, criterionKey: nextCriterionKey(keys) };
    }

    if (type === 'CLIENT_DEPENDENCY_SHEET') {
      return { ...payload, dependencyKey: nextDependencyKey(keys) };
    }

    if (type === 'WORK_BREAKDOWN_STRUCTURE') {
      /*
       * A hand-added work package is numbered under the parent it was given, so it
       * lands in the outline where somebody put it rather than at the end of the tree.
       * An unknown parent is refused: there is nothing to add the work under, and a row
       * numbered against a parent that does not exist would break the hierarchy checks.
       */
      const parentId = typeof payload.parentId === 'string' ? payload.parentId : undefined;

      if (
        parentId !== undefined &&
        !existing.some((row) => (row.payload as { wbsId?: string }).wbsId === parentId)
      ) {
        throw new DocumentError(DOCUMENT_ERROR_CODES.WBS_PARENT_NOT_FOUND, 422);
      }

      return { ...payload, wbsId: nextOutlineNumber(parentId, keys) };
    }

    return { ...payload, assumptionKey: nextAssumptionKey(keys) };
  }

  /**
   * Turn requested reference ids into references, having checked each exists.
   *
   * A citation that names nothing is worse than none — it survives review — so
   * every id is looked up in the approved baseline or the approved Feature Listing
   * before it becomes a reference.
   */
  private async verifiedReferences(
    context: DocumentContext,
    type: DocumentType,
    ids: readonly string[],
  ): Promise<DocumentReference[]> {
    if (ids.length === 0) {
      return [];
    }

    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const requirements = new Map(
      upstream.context.requirements.map((requirement) => [requirement.key, requirement]),
    );
    const features = new Map(
      (upstream.context.documents.featureListing?.features ?? []).map((feature) => [
        feature.featureId,
        feature,
      ]),
    );

    const references: DocumentReference[] = [];

    for (const id of ids) {
      const requirement = requirements.get(id);

      if (requirement) {
        references.push(requirementReference(requirement));
        continue;
      }

      if (features.has(id)) {
        references.push({ kind: 'ESTIMATE_UNIT', id, label: features.get(id)!.description });
        continue;
      }

      throw new DocumentError(
        requirements.size === 0 || id.startsWith('REQ-')
          ? DOCUMENT_ERROR_CODES.UNKNOWN_REQUIREMENT
          : DOCUMENT_ERROR_CODES.UNKNOWN_FEATURE,
        422,
      );
    }

    return references;
  }

  /* --------------------------------------------- targeted regeneration */

  /**
   * Rewrite the wording of specific feature rows, and nothing else.
   *
   * `featureIds` selects rows directly; `module` selects every row in one module.
   * Rows outside the selection are carried forward unchanged — same wording, same
   * review status, same hours — so a targeted rewrite cannot quietly reword the
   * rest of the sheet.
   *
   * **Effort never comes from here.** Each selected row keeps the effort, total and
   * estimate-unit references it already had, which came from the approved estimate.
   * `named` supplies wording only, and the schema it arrives under has no effort
   * field at all.
   *
   * A row somebody edited gets a **proposal**: the wording stays and the suggestion
   * waits beside it, exactly as a protected section does.
   */
  async regenerateFeatures(
    context: DocumentContext,
    type: DocumentType,
    selection: { readonly featureIds?: readonly string[]; readonly module?: string },
    expectedVersion: number,
    named: ReadonlyMap<
      string,
      { module: string; submodule: string; screen: string; description: string }
    >,
    reason?: string,
  ): Promise<{ snapshot: DocumentSnapshot; proposed: boolean; touched: readonly string[] }> {
    const record = await this.editableDocument(context, type, expectedVersion);

    if (DOCUMENT_SHAPE_BY_TYPE[type] !== 'ROWS') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422);
    }

    const content = await this.currentContent(context.projectId, record);
    const wanted = new Set(selection.featureIds ?? []);

    const selected = content.features.filter((row) =>
      selection.module !== undefined
        ? row.module.toLowerCase() === selection.module.toLowerCase()
        : wanted.has(row.featureId),
    );

    if (selected.length === 0) {
      throw new DocumentError(
        selection.module === undefined
          ? DOCUMENT_ERROR_CODES.FEATURE_NOT_FOUND
          : DOCUMENT_ERROR_CODES.MODULE_NOT_FOUND,
        404,
      );
    }

    /* Archive the version being replaced before anything is written. */
    await this.archive(context.projectId, record, content);

    const version = await this.repository.nextVersion(context.projectId, type);
    const now = new Date();
    const selectedIds = new Set(selected.map((row) => row.featureId));
    let proposed = false;

    const rows = content.features.map((row) => {
      const featureId = DocumentsRepository.newId('ftr');

      if (!selectedIds.has(row.featureId)) {
        /* Untouched, down to the review status and the hours. */
        return toFeatureRecord(row, version, { featureId });
      }

      const wording = named.get(row.estimateUnitIds.join('|')) ?? {
        module: row.module,
        submodule: row.submodule,
        screen: row.screen,
        description: row.description,
      };

      if (mayReplaceFeatureDirectly(row)) {
        return toFeatureRecord({ ...row, ...wording }, version, { featureId });
      }

      proposed = true;

      return toFeatureRecord(row, version, {
        featureId,
        proposed: { ...wording },
        proposedAt: now,
      });
    });

    await this.repository.update(context.projectId, type, record.recordVersion, {
      version,
      status: record.status === 'APPROVED' ? 'DRAFT' : record.status,
      supersedesVersion: record.version,
      regenerationReason: reason ?? '',
      validation: null,
    });

    /* Sections carry forward untouched; a row document has none, but a later
       document type may have both, and copying them keeps this general. */
    await this.repository.replaceSections(
      context.projectId,
      type,
      version,
      content.sections.map((section) => ({
        sectionId: DocumentsRepository.newId('dsc'),
        documentVersion: version,
        key: section.key,
        title: section.title,
        order: section.order,
        body: section.body,
        origin: section.origin,
        omittedReason: section.omittedReason ?? '',
        references: section.references,
        proposedBody: section.proposedBody ?? '',
        regenerationReason: section.regenerationReason ?? '',
      })),
    );

    await this.repository.replaceFeatures(context.projectId, type, version, rows);

    await this.audit.record({
      type: 'DOCUMENT_SECTION_REGENERATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: type,
        version,
        ...(selection.module !== undefined ? { module: selection.module } : {}),
        featureCount: selected.length,
        proposedOnly: proposed,
      },
    });

    if (record.status === 'APPROVED') {
      await this.markDependentsOutdated(context, type);
    }

    return {
      snapshot: await this.reload(context, type),
      proposed,
      touched: selected.map((row) => row.featureId),
    };
  }

  /** Keep the wording, take the suggestion, or start from it and edit. */
  async resolveFeatureProposal(
    context: DocumentContext,
    type: DocumentType,
    featureId: string,
    request: ResolveFeatureProposal,
  ): Promise<DocumentSnapshot> {
    const record = await this.editableDocument(context, type, request.expectedVersion);
    const feature = await this.repository.findFeature(context.projectId, featureId, record.version);

    if (feature?.type !== type) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.FEATURE_NOT_FOUND, 404);
    }

    if (!feature.proposed) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.NO_FEATURE_PROPOSAL, 422);
    }

    const suggestion = feature.proposed;
    const chosen =
      request.decision === 'KEEP_CURRENT'
        ? {}
        : request.decision === 'ACCEPT_GENERATED_REVISION'
          ? suggestion
          : {
              module: request.module ?? suggestion.module,
              submodule: request.submodule ?? suggestion.submodule,
              screen: request.screen ?? suggestion.screen,
              description: request.description ?? suggestion.description,
            };

    await this.repository.updateFeature(context.projectId, featureId, record.version, {
      ...chosen,
      /* Their decision, so the row stays theirs. */
      reviewStatus: 'USER_EDITED',
      proposed: null,
    });

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      featureId,
      decision: request.decision,
    });

    return this.reload(context, type);
  }

  /* ------------------------------------------------------- corrections */

  /**
   * Records a correction instruction before it is carried out.
   *
   * Written first, so a run that fails still leaves the request on the record —
   * "we asked for this and it did not work" is exactly the case a history is for.
   * The audit event carries a length and an outcome; the text stays in the
   * project's own collection.
   */
  async openCorrection(
    context: DocumentContext,
    type: DocumentType,
    request: ApplyCorrection,
    documentVersion: number,
  ): Promise<string> {
    const correctionId = DocumentsRepository.newId('dcr');

    await this.repository.recordCorrection({
      correctionId,
      projectId: context.projectId,
      type,
      targetKind: request.targetKind,
      targetKey: request.targetKey ?? '',
      instruction: request.instruction,
      actor: 'USER',
      documentVersion,
      outcome: 'NOT_APPLIED',
      producedProposal: false,
      usedAi: request.useAi,
    });

    await this.audit.record({
      type: 'DOCUMENT_SECTION_REGENERATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: correctionAuditMetadata({
        type,
        targetKind: request.targetKind,
        ...(request.targetKey ? { targetKey: request.targetKey } : {}),
        instruction: request.instruction,
        documentVersion,
        outcome: 'NOT_APPLIED',
        usedAi: request.useAi,
      }),
    });

    return correctionId;
  }

  /** Closes the record once the run has finished, whatever came of it. */
  async closeCorrection(
    correctionId: string,
    outcome: CorrectionOutcome,
    detail: { readonly resultingVersion?: number; readonly runId?: string },
  ): Promise<void> {
    await this.repository.completeCorrection(correctionId, {
      outcome,
      producedProposal: outcome === 'PROPOSED',
      ...(detail.resultingVersion !== undefined
        ? { resultingVersion: detail.resultingVersion }
        : {}),
      ...(detail.runId ? { runId: detail.runId } : {}),
    });
  }

  async listCorrections(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<readonly CorrectionInstruction[]> {
    const records = await this.repository.listCorrections(context.projectId, type);

    return records.map((record) => ({
      correctionId: record.correctionId,
      projectId: record.projectId,
      type: record.type as DocumentType,
      targetKind: record.targetKind as CorrectionInstruction['targetKind'],
      ...(record.targetKey ? { targetKey: record.targetKey } : {}),
      instruction: record.instruction,
      actor: 'USER' as const,
      documentVersion: record.documentVersion,
      ...(record.resultingVersion !== undefined
        ? { resultingVersion: record.resultingVersion }
        : {}),
      ...(record.runId ? { runId: record.runId } : {}),
      outcome: record.outcome as CorrectionOutcome,
      producedProposal: record.producedProposal,
      usedAi: record.usedAi,
      createdAt: record.createdAt.toISOString(),
    }));
  }

  /** Rows waiting for a decision. Used by the blocker calculation. */
  static featuresAwaitingDecision(rows: readonly FeatureRow[]): readonly string[] {
    return rows.filter(hasFeatureProposal).map((row) => row.featureId);
  }

  private async reload(context: DocumentContext, type: DocumentType): Promise<DocumentSnapshot> {
    const record = await this.repository.find(context.projectId, type);

    if (!record) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND, 404);
    }

    return this.assemble(context, record);
  }

  /** A document that does not exist yet, described honestly. */
  private emptySnapshot(context: DocumentContext, type: DocumentType): DocumentSnapshot {
    const now = new Date().toISOString();

    return {
      documentId: '',
      type,
      projectId: context.projectId,
      version: 1,
      status: 'NOT_STARTED',
      /* Nothing has been written, so nothing can have gone out of date. */
      currentness: 'CURRENT',
      title: DOCUMENT_LABELS[type],
      prerequisiteVersions: {},
      sections: [],
      features: [],
      rows: [],
      criteriaCoverage: null,
      assumptionSummary: null,
      wbsReconciliation: null,
      wbsCoverage: null,
      dependencySummary: null,
      reverseDependencies: null,
      scopeReconciliation: null,
      validation: null,
      blockers: [
        {
          kind: 'not_generated',
          count: 1,
          summary: 'This document has not been written yet.',
          action: 'Generate it, or write the sections yourself.',
          subjectIds: [],
        },
      ],
      outdatedReasons: [],
      coverage: null,
      reconciliation: null,
      generator: null,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      recordVersion: 0,
    };
  }

  /** The comparable projection of a document, whatever its shape. */
  private contentEntries(snapshot: DocumentSnapshot): readonly ContentEntry[] {
    if (snapshot.sections.length > 0) {
      return snapshot.sections.map((section) => ({
        key: section.key,
        title: section.title,
        body: section.body,
      }));
    }

    if (snapshot.features.length > 0) {
      return snapshot.features.map((feature) => ({
        /* Keyed by the estimate unit, which is what a row's identity is. */
        key: feature.estimateUnitIds.join('|') || feature.featureId,
        title: `${feature.module} — ${feature.screen || feature.submodule || 'no screen'}`,
        body: `${feature.description} (${feature.totalHours}h)`,
        fields: featureFields(feature),
      }));
    }

    /*
     * The generic row channel — acceptance criteria, assumptions, work packages,
     * client dependencies.
     *
     * Keyed by the row's own stable key, so a criterion that moved position reads as
     * unchanged and one that was genuinely rewritten reads as changed. Comparing by
     * array index would report every row after an insertion as modified, which makes
     * a history useless exactly when somebody is trying to see what a reviewer did.
     */
    return snapshot.rows.map((row) => {
      const key = DocumentsService.rowKey(row.payload as Record<string, unknown>) || row.rowId;

      return {
        key,
        title: rowTitle(row),
        body: rowSummary(row),
        fields: rowFields(row),
      };
    });
  }

  /** True when a section is waiting for a decision. Used by the controller. */
  static awaitingDecision(sections: readonly DocumentSection[]): boolean {
    return sections.some(hasProposal);
  }
}
