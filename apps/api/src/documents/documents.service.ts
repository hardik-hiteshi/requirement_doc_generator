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
  documentOutdatedReasons,
  documentsDependingOn,
  featureListingCsv,
  hasProposal,
  IMPLEMENTED_DOCUMENT_TYPES,
  isDocumentAuthoritative,
  isDocumentEditable,
  isDocumentRunning,
  isImplementedDocumentType,
  isSectionProtected,
  lockFor,
  mayReplaceDirectly,
  validationIsCurrent,
  validationPermitsApproval,
  worstSeverity,
  type ApproveDocument,
  type ContentEntry,
  type DocumentDiff,
  type DocumentSection,
  type DocumentSnapshot,
  type DocumentSummary,
  type DocumentType,
  type DocumentValidation,
  type DocumentVersionSummary,
  type FeatureRow,
  type GenerateDocument,
  type MarkFinal,
  type ReopenDocument,
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
import { UpstreamReader, type UpstreamSnapshot } from './upstream.reader';
import { FeatureListingComposer } from './composers/feature-listing.composer';
import { UnderstandingComposer } from './composers/understanding.composer';
import type { ComposedContent, DocumentComposer } from './composers/composer.types';
import {
  toDocumentSnapshot,
  toFeatureRow,
  toSection,
  toVersionSummary,
  type StoredContent,
} from './documents.mapper';
import type { DocumentDocument } from './schemas/document.schema';

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
  ) {
    this.composers = new Map<DocumentType, DocumentComposer>([
      [understanding.type, understanding],
      [featureListing.type, featureListing],
    ]);
  }

  /* --------------------------------------------------------------- reads */

  /**
   * Every document's state, whether it exists or not.
   *
   * The unimplemented five are included and marked unavailable rather than
   * hidden. A user who can see that Statement of Work is coming, and that it is
   * not here yet, is better informed than one who sees two documents and wonders.
   */
  async list(context: DocumentContext): Promise<readonly DocumentSummary[]> {
    const upstream = await this.upstream.read(context.projectId, context.correlationId);
    const records = await this.repository.findAll(context.projectId);
    const byType = new Map(records.map((record) => [record.type as DocumentType, record]));

    const statuses = Object.fromEntries(
      records.map((record) => [record.type, record.status]),
    ) as Partial<Record<DocumentType, DocumentSnapshot['status']>>;

    return DOCUMENT_TYPES.map((type) => {
      const record = byType.get(type);
      const lock = lockFor(
        type,
        { availableUpstream: this.availableUpstream(upstream), documentStatuses: statuses },
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
        outdated: (record?.outdatedReasons ?? []).length > 0,
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

    return versions.map(toVersionSummary);
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
    await this.assertUnlocked(context, type, upstream);

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

    const record = existing
      ? await this.repository.update(context.projectId, type, existing.recordVersion, {
          version,
          status: 'DRAFT',
          ...this.upstreamFields(upstream),
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

    await this.audit.record({
      type: 'DOCUMENT_GENERATION_COMPLETED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: type,
        version,
        sectionCount: sections.length,
        featureCount: features.length,
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
    const section = await this.repository.findSection(context.projectId, sectionId);

    if (section?.type !== type || section.documentVersion !== record.version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
    }

    await this.repository.updateSection(context.projectId, sectionId, {
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

    await this.afterContentChange(context, type, record, 'DOCUMENT_EDITED', {
      sectionKey: section.key,
    });

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
    const section = await this.repository.findSection(context.projectId, sectionId);

    if (section?.type !== type || section.documentVersion !== record.version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
    }

    const protectedSection = isSectionProtected(section.origin as DocumentSection['origin']);

    await this.repository.updateSection(context.projectId, sectionId, {
      /*
       * The whole edit-authority rule, in one branch. A section nobody has
       * touched is replaced. A section a person wrote keeps its body and gains a
       * proposal, and the decision is theirs — see `resolveProposal`.
       */
      ...(protectedSection ? { proposedBody: body, proposedAt: new Date() } : { body }),
      regenerationReason: reason ?? '',
    });

    await this.afterContentChange(context, type, record, 'DOCUMENT_SECTION_REGENERATED', {
      sectionKey: section.key,
      proposedOnly: protectedSection,
    });

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
    const section = await this.repository.findSection(context.projectId, sectionId);

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

    await this.repository.updateSection(context.projectId, sectionId, {
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
    const feature = await this.repository.findFeature(context.projectId, featureId);

    if (feature?.type !== type || feature.documentVersion !== record.version) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.FEATURE_NOT_FOUND, 404);
    }

    const { expectedVersion: _ignored, ...fields } = request;

    await this.repository.updateFeature(context.projectId, featureId, {
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
        sections: content.sections.map((section) => ({ key: section.key, body: section.body })),
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

    if (isDocumentAuthoritative(status)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_ALREADY_APPROVED, 409);
    }

    if (!canTransitionDocument(status, 'APPROVED')) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.INVALID_STATUS_TRANSITION, 409);
    }

    const snapshot = await this.assemble(context, record);
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

    if (status === 'FINAL') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_FINAL, 409);
    }

    if (status !== 'APPROVED') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_APPROVED, 409);
    }

    await this.repository.update(
      context.projectId,
      type,
      record.recordVersion,
      { status: 'NEEDS_REVISION', regenerationReason: request.reason },
      ['approvedAt'],
    );

    await this.audit.record({
      type: 'DOCUMENT_REOPENED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, version: record.version },
    });

    await this.markDependentsOutdated(context, type);

    return this.reload(context, type);
  }

  /** Mark issued. Irreversible: a revision means a new version. */
  async markFinal(
    context: DocumentContext,
    type: DocumentType,
    request: MarkFinal,
  ): Promise<DocumentSnapshot> {
    this.assertImplemented(type);

    const record = await this.expect(context, type, request.expectedVersion);
    const status = record.status as DocumentSnapshot['status'];

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
    await this.repository.updateVersion(context.projectId, type, record.version, { finalAt: now });

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

    const features = (stored.features as unknown as FeatureRow[]).map((feature) => ({
      ...feature,
      featureId: DocumentsRepository.newId('ftr'),
      projectId: context.projectId,
      type,
      documentVersion: version,
      references: feature.references,
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

  private async assertUnlocked(
    context: DocumentContext,
    type: DocumentType,
    upstream: UpstreamSnapshot,
  ): Promise<void> {
    const records = await this.repository.findAll(context.projectId);
    const statuses = Object.fromEntries(
      records.map((record) => [record.type, record.status]),
    ) as Partial<Record<DocumentType, DocumentSnapshot['status']>>;

    const lock = lockFor(
      type,
      { availableUpstream: this.availableUpstream(upstream), documentStatuses: statuses },
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
    auditType: 'DOCUMENT_EDITED' | 'DOCUMENT_SECTION_REGENERATED',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const wasApproved = record.status === 'APPROVED';

    await this.repository.touch(context.projectId, type, {
      ...(wasApproved ? { status: 'DRAFT' } : {}),
      /* The stored result described the previous content. */
      validation: null,
    });

    await this.audit.record({
      type: auditType,
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { documentType: type, version: record.version, ...metadata },
    });

    if (wasApproved) {
      await this.markDependentsOutdated(context, type);
    }
  }

  /** Marks documents built on this one out of date. Never regenerates them. */
  private async markDependentsOutdated(
    context: DocumentContext,
    type: DocumentType,
  ): Promise<void> {
    for (const dependent of documentsDependingOn(type)) {
      const record = await this.repository.find(context.projectId, dependent);

      if (!record || record.status === 'NOT_STARTED' || record.status === 'FINAL') {
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

      await this.repository.touch(context.projectId, dependent, {
        outdatedReasons: reasons,
        ...(isDocumentAuthoritative(record.status as DocumentSnapshot['status'])
          ? { status: 'OUTDATED' }
          : {}),
      });

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

  private async currentContent(
    projectId: string,
    record: DocumentDocument,
  ): Promise<StoredContent> {
    const [sections, features] = await Promise.all([
      this.repository.listSections(projectId, record.type, record.version),
      this.repository.listFeatures(projectId, record.type, record.version),
    ]);

    return {
      sections: sections.map(toSection),
      features: features.map(toFeatureRow),
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
  ): Promise<void> {
    const existing = await this.repository.findVersion(projectId, record.type, record.version);
    const payload = {
      status: status ?? record.status,
      sections: content.sections as unknown as Record<string, unknown>[],
      features: content.features as unknown as Record<string, unknown>[],
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

    const reasons = [
      ...documentOutdatedReasons({
        type,
        generatedAgainst: {
          ...(record.baselineVersion !== undefined
            ? { baselineVersion: record.baselineVersion }
            : {}),
          ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
          ...(record.estimateVersion !== undefined
            ? { estimateVersion: record.estimateVersion }
            : {}),
        },
        current: {
          ...(upstream.context.baseline
            ? { baselineVersion: upstream.context.baseline.version }
            : {}),
          ...(upstream.context.stack ? { stackVersion: upstream.context.stack.version } : {}),
          ...(upstream.context.estimate
            ? { estimateVersion: upstream.context.estimate.version }
            : {}),
        },
        changedPrerequisites: [],
      }),
      /* Prerequisite changes are recorded on the document as they happen. */
      ...(record.outdatedReasons as unknown as DocumentSnapshot['outdatedReasons']),
    ];

    const excluded = record.exclusions.map((entry) => entry.requirementId);

    const coverage =
      composer.shape === 'ROWS'
        ? this.featureListing.coverageFor(upstream.context, content.features, excluded)
        : null;
    const reconciliation =
      composer.shape === 'ROWS'
        ? this.featureListing.reconciliationFor(upstream.context, content.features)
        : null;

    const unapproved = DOCUMENT_DEPENDENCIES[type].documents.filter((prerequisite) => {
      const status = upstream.documentStatuses[prerequisite];

      return status !== undefined && !isDocumentAuthoritative(status);
    });

    const blockers = calculateDocumentBlockers({
      generated: content.sections.length > 0 || content.features.length > 0,
      sections: content.sections,
      requiredSectionKeys: composer.requiredSectionKeys,
      validation: record.validation as unknown as DocumentValidation | null,
      outdatedReasons: reasons,
      coverage,
      reconciliation,
      unapprovedPrerequisites: unapproved,
    });

    /*
     * An approved document whose inputs moved is reported as OUTDATED without
     * being rewritten. The status is derived here rather than written by a
     * background job, so it cannot be stale.
     */
    const status =
      reasons.length > 0 && isDocumentAuthoritative(record.status as DocumentSnapshot['status'])
        ? 'OUTDATED'
        : (record.status as DocumentSnapshot['status']);

    return toDocumentSnapshot(record, content, {
      status,
      blockers,
      outdatedReasons: reasons,
      coverage,
      reconciliation,
    });
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
      title: DOCUMENT_LABELS[type],
      prerequisiteVersions: {},
      sections: [],
      features: [],
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

    return snapshot.features.map((feature) => ({
      /* Keyed by the estimate unit, which is what a row's identity is. */
      key: feature.estimateUnitIds.join('|') || feature.featureId,
      title: `${feature.module} — ${feature.screen || feature.submodule || 'no screen'}`,
      body: `${feature.description} (${feature.totalHours}h)`,
    }));
  }

  /** True when a section is waiting for a decision. Used by the controller. */
  static awaitingDecision(sections: readonly DocumentSection[]): boolean {
    return sections.some(hasProposal);
  }
}
