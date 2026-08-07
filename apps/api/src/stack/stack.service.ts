import { Injectable } from '@nestjs/common';
import {
  CATALOG_VERSION,
  EMPTY_CONSTRAINTS,
  STACK_ERROR_CODES,
  STACK_LIMITS,
  TECHNOLOGY_CATALOG,
  aiMayReplace,
  allowsMultiple,
  authorityOf,
  calculateStackBlockers,
  calculateStackEvidence,
  canApproveStack,
  canLockStack,
  canTransitionComponent,
  evaluateCompatibility,
  findTechnology,
  fillsCategory,
  highestRisk,
  isDecided,
  needsAcknowledgement,
  planCategories,
  projectTypeIsActionable,
  requiredCategories,
  resolveByName,
  suitsProjectType,
  DOWNSTREAM_AUTHORITY_VERSION,
  type AcknowledgeRisk,
  type ApproveStack,
  type CatalogEntry,
  type CategoryApplicabilityEntry,
  type ComponentFacts,
  type DecideRecommendation,
  type DownstreamAuthority,
  type LockStack,
  type ProjectType,
  type SelectTechnology,
  type StackComponent,
  type StackComponentStatus,
  type StackConstraints,
  type StackDecision,
  type StackDecisionKind,
  type StackSelectionMode,
  type StackSnapshot,
  type StackSnapshotStatus,
  type TechnologyCategory,
  type TechnologyMandate,
  type UnlockStack,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { ProjectRepository } from '../projects/project.repository';
import { AnalysisRepository } from '../analysis/analysis.repository';
import { BaselineService } from '../analysis/baseline.service';
import { StackError } from './stack.errors';
import { StackRepository } from './stack.repository';
import { toComponent, toSnapshot } from './stack.mapper';
import { deriveConstraints } from './constraints.service';
import type { StackComponentDocument, StackSnapshotDocument } from './schemas/stack.schema';

export interface StackContext {
  readonly projectId: string;
  readonly correlationId: string;
}

/**
 * The technology-stack workflow, from an approved baseline to a locked stack.
 *
 * Four commitments run through every method, and each exists because breaking
 * it produces a proposal a client would be wrong to trust.
 *
 * **The user's decision wins, always.** Every write path routes through
 * `aiMayReplace`, and a recommendation cannot reach a slot at
 * `USER_SELECTED`, `USER_APPROVED` or `LOCKED`. When the model disagrees with a
 * user's choice it produces a warning that is shown, acknowledged and carried
 * forward — never a substitution.
 *
 * **Facts come from the catalogue, not the model.** Licence, cost posture and
 * self-hostability are copied from a reviewed entry at the moment of the
 * decision. A model that names a technology contributes prose and a
 * self-assessment; it never contributes a commercial fact.
 *
 * **Nothing is decided automatically.** A suggestion sits at `AI_RECOMMENDED`
 * and blocks approval until a person accepts, rejects or replaces it. A stack
 * that could be approved with unread suggestions in it is a stack nobody chose.
 *
 * **Locking is a wall.** Once locked, no automatic path writes to a component:
 * not a re-recommendation, not a baseline change, not a bulk operation. The only
 * way out is an explicit unlock, which supersedes the snapshot and marks
 * everything built on it out of date.
 */
@Injectable()
export class StackService {
  constructor(
    private readonly repository: StackRepository,
    private readonly analysis: AnalysisRepository,
    private readonly baselines: BaselineService,
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
  ) {}

  /* --------------------------------------------------------- reading */

  /**
   * The current stack, created on first read if there is none.
   *
   * Created lazily rather than when the baseline is approved, so a project that
   * never reaches this step leaves no empty snapshot behind — and so the
   * snapshot records the project types *as they were when the user arrived
   * here*, which is what makes a later change detectable.
   */
  async current(context: StackContext): Promise<StackView> {
    const existing = await this.repository.currentSnapshot(context.projectId);
    const snapshot = existing ?? (await this.createInitial(context));

    return this.assemble(context, snapshot);
  }

  async listVersions(context: StackContext): Promise<StackSnapshot[]> {
    const snapshots = await this.repository.listSnapshots(context.projectId);
    const views: StackSnapshot[] = [];

    for (const snapshot of snapshots) {
      const components = await this.repository.listComponents(context.projectId, snapshot.version);

      views.push(toSnapshot(snapshot, components.map(toComponent)));
    }

    return views;
  }

  async version(context: StackContext, version: number): Promise<StackSnapshot> {
    const snapshot = await this.repository.findSnapshot(context.projectId, version);

    if (!snapshot) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 404);
    }

    const components = await this.repository.listComponents(context.projectId, version);

    return toSnapshot(snapshot, components.map(toComponent));
  }

  /**
   * The catalogue, filtered to what makes sense here.
   *
   * Filtered rather than complete, because offering a user an iOS language on
   * an Android brief is an invitation to a mistake the compatibility rules will
   * then have to catch. Everything filtered out is still reachable — they can
   * type any technology they want, and it is recorded exactly as typed.
   */
  async catalog(context: StackContext): Promise<CatalogView> {
    const project = await this.projects.findByProjectId(context.projectId);
    const projectTypes = (project?.projectTypes ?? []) as readonly ProjectType[];

    const entries =
      projectTypes.length === 0
        ? TECHNOLOGY_CATALOG
        : TECHNOLOGY_CATALOG.filter((entry) =>
            projectTypes.some((type) => suitsProjectType(entry, type)),
          );

    return { catalogVersion: CATALOG_VERSION, entries: [...entries] };
  }

  /* ---------------------------------------------------------- mode */

  async setMode(
    context: StackContext,
    mode: StackSelectionMode,
    expectedVersion: number,
  ): Promise<StackView> {
    const snapshot = await this.editable(context, expectedVersion);

    const updated = await this.repository.updateSnapshot(
      context.projectId,
      snapshot.snapshotId,
      expectedVersion,
      {
        selectionMode: mode,
        decisions: [
          ...snapshot.decisions,
          decision('mode_selected', { note: `Selection mode set to ${mode}.` }),
        ],
      },
    );

    if (!updated) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'TECH_STACK_MODE_SELECTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { mode },
    });

    return this.assemble(context, updated);
  }

  /* ------------------------------------------------------ selection */

  /**
   * Choose a technology for a category.
   *
   * The path a user takes in `USER_SELECTS_ALL` and in `HYBRID`, and the one
   * that has to work with no inference server running at all — nothing in here
   * touches a provider.
   */
  async select(context: StackContext, request: SelectTechnology): Promise<StackView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const plan = await this.planFor(context, snapshot);
    const applicability = plan.find((entry) => entry.category === request.category);

    if (!applicability || applicability.applicability === 'not_applicable') {
      throw new StackError(STACK_ERROR_CODES.CATEGORY_NOT_APPLICABLE, 422);
    }

    const resolved = this.resolveTechnology(request);

    if (resolved.entry && !fillsCategory(resolved.entry, request.category)) {
      throw new StackError(STACK_ERROR_CODES.TECHNOLOGY_WRONG_CATEGORY, 422);
    }

    await this.assertRequirementsExist(context, request.requirementIds ?? []);

    const existing = await this.repository.liveInCategory(
      context.projectId,
      snapshot.version,
      request.category,
    );

    /*
     * A locked component is not displaced by a selection. This is the same
     * refusal as everywhere else in the phase: the lock is a wall, and a request
     * that would have gone through it fails loudly rather than quietly winning.
     */
    if (existing.some((component) => component.status === 'LOCKED')) {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_LOCKED, 409);
    }

    if (existing.length > 0 && !allowsMultiple(request.category)) {
      // Supersede rather than delete: the record shows what was there.
      for (const component of existing) {
        await this.repository.updateComponent(
          context.projectId,
          component.componentId,
          component.recordVersion,
          { status: 'SUPERSEDED', authority: authorityOf('SUPERSEDED') },
        );
      }
    }

    if (
      (await this.repository.countComponents(context.projectId, snapshot.version)) >=
      STACK_LIMITS.maxComponents
    ) {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_LIMIT_REACHED, 422);
    }

    const evidenceKind = request.mandatory
      ? 'CLIENT_REQUIREMENT'
      : request.selectionSource === 'EXISTING_INFRASTRUCTURE'
        ? 'PROJECT_CONSTRAINT'
        : 'USER_PREFERENCE';

    const evidenceStrength = calculateStackEvidence({
      evidenceKind,
      requirementIds: request.requirementIds ?? [],
      clarificationKeys: [],
      mandatedByRequirement: request.mandatory,
      satisfiesStatedConstraint: request.selectionSource === 'EXISTING_INFRASTRUCTURE',
      userSelected: true,
      inCatalog: Boolean(resolved.entry),
      hasOpenConflict: false,
      missingInfrastructureContext: false,
    });

    await this.repository.createComponent({
      componentId: StackRepository.newId('cmp'),
      projectId: context.projectId,
      stackVersion: snapshot.version,
      category: request.category,
      ...(resolved.entry ? { technologyId: resolved.entry.id } : {}),
      technologyName: resolved.name,
      status: 'USER_SELECTED',
      authority: authorityOf('USER_SELECTED'),
      selectionSource: request.selectionSource,
      mandatory: request.mandatory,
      version: request.version ?? { source: 'UNSPECIFIED' },
      evidence: {
        kind: evidenceKind,
        requirementIds: request.requirementIds ?? [],
        sourceIds: [],
        clarificationKeys: [],
        summary: request.mandatory ? 'Your requirements name this technology.' : 'You chose this.',
      },
      evidenceStrength: evidenceStrength.score,
      evidenceContributions: [...evidenceStrength.contributions] as unknown as Record<
        string,
        unknown
      >[],
      licence: resolved.entry?.licence ?? '',
      costPosture: resolved.entry?.costPosture ?? 'UNKNOWN',
      selfHostable: resolved.entry?.selfHostable ?? false,
      riskAcknowledgements: [],
      notes: request.notes ?? '',
    });

    await this.audit.record({
      type: 'TECH_COMPONENT_SELECTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        category: request.category,
        source: request.selectionSource,
        mandatory: request.mandatory,
        inCatalog: Boolean(resolved.entry),
      },
    });

    return this.recalculate(context, snapshot, 'component_selected', {
      category: request.category,
      technologyName: resolved.name,
      note: 'Chosen by you.',
    });
  }

  /**
   * Accept, reject or replace an AI suggestion.
   *
   * The step that stops a stack being approved on the model's say-so. All three
   * outcomes are recorded — a rejection is as much a decision as an acceptance,
   * and knowing what was offered and turned down is what makes the record
   * useful six months later.
   */
  async decide(
    context: StackContext,
    componentId: string,
    request: DecideRecommendation,
  ): Promise<StackView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const component = await this.componentOr404(context, componentId);

    if (component.status === 'LOCKED') {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_LOCKED, 409);
    }

    if (component.status !== 'AI_RECOMMENDED') {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_NOT_RECOMMENDED, 422);
    }

    if (request.decision === 'accept') {
      await this.transition(context, component, 'USER_APPROVED', {
        // Accepting is the user adopting it, so it is now *their* choice — and
        // the evidence recalculates to say so.
        evidenceStrength: this.strengthAfterAcceptance(component),
      });

      await this.audit.record({
        type: 'TECH_RECOMMENDATION_ACCEPTED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { category: component.category },
      });

      return this.recalculate(context, snapshot, 'recommendation_accepted', {
        category: component.category,
        technologyName: component.technologyName,
        note: 'You accepted this suggestion.',
      });
    }

    if (request.decision === 'reject') {
      await this.transition(context, component, 'REJECTED', {});

      await this.audit.record({
        type: 'TECH_RECOMMENDATION_REJECTED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { category: component.category },
      });

      return this.recalculate(context, snapshot, 'recommendation_rejected', {
        category: component.category,
        technologyName: component.technologyName,
        note: request.reason ?? 'You rejected this suggestion.',
      });
    }

    /* Replace: the old one becomes history and the new one is the user's. */
    const resolved = this.resolveTechnology(request);

    if (
      resolved.entry &&
      !fillsCategory(resolved.entry, component.category as TechnologyCategory)
    ) {
      throw new StackError(STACK_ERROR_CODES.TECHNOLOGY_WRONG_CATEGORY, 422);
    }

    await this.transition(context, component, 'SUPERSEDED', {});

    const evidenceStrength = calculateStackEvidence({
      evidenceKind: 'USER_PREFERENCE',
      requirementIds: [],
      clarificationKeys: [],
      mandatedByRequirement: false,
      satisfiesStatedConstraint: false,
      userSelected: true,
      inCatalog: Boolean(resolved.entry),
      hasOpenConflict: false,
      missingInfrastructureContext: false,
    });

    await this.repository.createComponent({
      componentId: StackRepository.newId('cmp'),
      projectId: context.projectId,
      stackVersion: snapshot.version,
      category: component.category,
      ...(resolved.entry ? { technologyId: resolved.entry.id } : {}),
      technologyName: resolved.name,
      status: 'USER_SELECTED',
      authority: authorityOf('USER_SELECTED'),
      selectionSource: 'USER',
      mandatory: false,
      version: { source: 'UNSPECIFIED' },
      evidence: {
        kind: 'USER_PREFERENCE',
        requirementIds: [],
        sourceIds: [],
        clarificationKeys: [],
        summary: 'You chose this instead of the suggestion.',
      },
      evidenceStrength: evidenceStrength.score,
      evidenceContributions: [...evidenceStrength.contributions] as unknown as Record<
        string,
        unknown
      >[],
      licence: resolved.entry?.licence ?? '',
      costPosture: resolved.entry?.costPosture ?? 'UNKNOWN',
      selfHostable: resolved.entry?.selfHostable ?? false,
      riskAcknowledgements: [],
      notes: '',
      replacedTechnologyName: component.technologyName,
      ...(request.reason ? { replacedReason: request.reason } : {}),
    });

    await this.audit.record({
      type: 'TECH_COMPONENT_REPLACED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { category: component.category, inCatalog: Boolean(resolved.entry) },
    });

    return this.recalculate(context, snapshot, 'component_replaced', {
      category: component.category,
      technologyName: resolved.name,
      previousTechnologyName: component.technologyName,
      note: request.reason ?? 'You replaced the suggestion.',
    });
  }

  /** Seal one component so nothing automatic can reach it. */
  async lockComponent(
    context: StackContext,
    componentId: string,
    expectedVersion: number,
  ): Promise<StackView> {
    const snapshot = await this.editable(context, expectedVersion);
    const component = await this.componentOr404(context, componentId);

    if (!canTransitionComponent(component.status as StackComponentStatus, 'LOCKED')) {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_NOT_RECOMMENDED, 422);
    }

    await this.transition(context, component, 'LOCKED', { lockedAt: new Date() });

    await this.audit.record({
      type: 'TECH_COMPONENT_LOCKED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { category: component.category },
    });

    return this.recalculate(context, snapshot, 'component_locked', {
      category: component.category,
      technologyName: component.technologyName,
      note: 'Locked.',
    });
  }

  /** Unlock one component. Deliberate, and recorded. */
  async unlockComponent(
    context: StackContext,
    componentId: string,
    expectedVersion: number,
  ): Promise<StackView> {
    const snapshot = await this.editable(context, expectedVersion, { allowLocked: true });
    const component = await this.componentOr404(context, componentId);

    if (component.status !== 'LOCKED') {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_NOT_RECOMMENDED, 422);
    }

    await this.repository.updateComponent(
      context.projectId,
      component.componentId,
      component.recordVersion,
      { status: 'USER_APPROVED', authority: authorityOf('USER_APPROVED') },
      ['lockedAt'],
    );

    await this.audit.record({
      type: 'TECH_COMPONENT_UNLOCKED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { category: component.category },
    });

    return this.recalculate(context, snapshot, 'component_unlocked', {
      category: component.category,
      technologyName: component.technologyName,
      note: 'Unlocked.',
    });
  }

  /* ------------------------------------------------------------- risk */

  /**
   * Record that a warning was read and the choice kept anyway.
   *
   * The mechanism that lets user authority and honest reporting coexist. The
   * technology stays, the risk is carried into the estimate and the documents,
   * and the record shows the user was told. Asked once — the acknowledgement is
   * stored against the requirement ids the risk was computed from, so it stops
   * covering the risk only if those change.
   */
  async acknowledgeRisk(context: StackContext, request: AcknowledgeRisk): Promise<StackView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const view = await this.assemble(context, snapshot);
    const finding = view.snapshot.compatibilityFindings.find(
      (candidate) => candidate.id === request.findingId,
    );

    if (!finding) {
      throw new StackError(STACK_ERROR_CODES.FINDING_NOT_FOUND, 404);
    }

    if (!needsAcknowledgement(finding.level)) {
      throw new StackError(STACK_ERROR_CODES.FINDING_NOT_ACKNOWLEDGEABLE, 422);
    }

    const now = new Date().toISOString();

    for (const componentId of finding.componentIds) {
      const component = await this.repository.findComponent(context.projectId, componentId);

      if (!component) {
        continue;
      }

      await this.repository.updateComponent(
        context.projectId,
        componentId,
        component.recordVersion,
        {
          riskAcknowledgements: [
            ...component.riskAcknowledgements,
            {
              findingId: finding.id,
              summary: finding.summary,
              note: request.note ?? '',
              acknowledgedAt: now,
              requirementIds: [...finding.requirementIds],
            },
          ],
        },
      );
    }

    await this.audit.record({
      type: 'TECH_RISK_ACKNOWLEDGED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { kind: finding.kind, level: finding.level },
    });

    return this.recalculate(context, snapshot, 'risk_acknowledged', {
      note: 'You read this warning and kept your choice.',
    });
  }

  /* -------------------------------------------------- approve and lock */

  async approve(context: StackContext, request: ApproveStack): Promise<StackView> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.recordVersion !== request.expectedVersion) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    if (snapshot.status === 'LOCKED') {
      throw new StackError(STACK_ERROR_CODES.STACK_LOCKED, 409);
    }

    if (snapshot.status === 'APPROVED') {
      throw new StackError(STACK_ERROR_CODES.STACK_ALREADY_APPROVED, 409);
    }

    const view = await this.assemble(context, snapshot);

    if (!canApproveStack(view.snapshot)) {
      throw new StackError(STACK_ERROR_CODES.STACK_HAS_BLOCKERS, 422, undefined, {
        blockers: view.snapshot.blockers,
      });
    }

    const updated = await this.repository.updateSnapshot(
      context.projectId,
      snapshot.snapshotId,
      snapshot.recordVersion,
      {
        status: 'APPROVED',
        approvedAt: new Date(),
        ...(request.note ? { approvalNote: request.note } : {}),
        decisions: [
          ...snapshot.decisions,
          decision('stack_approved', { note: request.note ?? 'Approved.' }),
        ],
      },
    );

    if (!updated) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'TECH_STACK_APPROVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { version: snapshot.version, componentCount: view.snapshot.components.length },
    });

    return this.assemble(context, updated);
  }

  /**
   * Lock the stack, which makes it authoritative for every later phase.
   *
   * Separate from approval on purpose. Approving says *these are the right
   * technologies*; locking says *build and price exactly this*, and Phase 6
   * consumes the result. Collapsing the two would mean an estimate built on a
   * stack nobody meant to commit to.
   */
  async lock(context: StackContext, request: LockStack): Promise<StackView> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.recordVersion !== request.expectedVersion) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    if (!canLockStack({ status: snapshot.status as StackSnapshotStatus })) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_APPROVED, 422);
    }

    const now = new Date();
    const components = await this.repository.listComponents(context.projectId, snapshot.version);

    // Everything live is locked with the stack. A stack that is locked while a
    // component inside it is not is a stack that can still change.
    for (const component of components) {
      if (component.status === 'USER_APPROVED' || component.status === 'USER_SELECTED') {
        await this.repository.updateComponent(
          context.projectId,
          component.componentId,
          component.recordVersion,
          { status: 'LOCKED', authority: authorityOf('LOCKED'), lockedAt: now },
        );
      }
    }

    const updated = await this.repository.updateSnapshot(
      context.projectId,
      snapshot.snapshotId,
      snapshot.recordVersion,
      {
        status: 'LOCKED',
        lockedAt: now,
        decisions: [
          ...snapshot.decisions,
          decision('stack_locked', { note: 'Locked as authoritative for later phases.' }),
        ],
      },
    );

    if (!updated) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'TECH_STACK_LOCKED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { version: snapshot.version },
    });

    return this.assemble(context, updated);
  }

  /**
   * Reopen a locked stack as a new version.
   *
   * The locked one is not edited — it is superseded, and it keeps saying
   * exactly what it said, because that is what was committed to. Work continues
   * on a copy, and anything built on the old version is detectably stale.
   */
  async unlock(context: StackContext, request: UnlockStack): Promise<StackView> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.recordVersion !== request.expectedVersion) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    if (snapshot.status !== 'LOCKED') {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_LOCKED, 422);
    }

    const nextVersion = await this.repository.nextSnapshotVersion(context.projectId);

    await this.repository.carryForward(context.projectId, snapshot.version, nextVersion);

    const created = await this.repository.createSnapshot({
      snapshotId: StackRepository.newId('stk'),
      projectId: context.projectId,
      version: nextVersion,
      status: 'DRAFT',
      selectionMode: snapshot.selectionMode,
      ...(snapshot.baselineId ? { baselineId: snapshot.baselineId } : {}),
      ...(snapshot.baselineVersion ? { baselineVersion: snapshot.baselineVersion } : {}),
      projectTypes: [...snapshot.projectTypes],
      categoryPlan: snapshot.categoryPlan,
      componentIds: [],
      compatibilityFindings: [],
      highestRisk: 'NONE',
      blockers: [],
      decisions: [...snapshot.decisions, decision('stack_reopened', { note: request.reason })],
    });

    await this.repository.supersedeSnapshots(context.projectId, nextVersion, nextVersion);

    await this.audit.record({
      type: 'TECH_STACK_REOPENED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { fromVersion: snapshot.version, toVersion: nextVersion },
    });

    return this.assemble(context, created);
  }

  /* ------------------------------------------------ downstream authority */

  /**
   * The contract a locked stack hands to Phase 6 and everything after it.
   *
   * Refuses on anything that is not locked. A downstream phase that could read
   * a draft would build on a stack still being edited, and the divergence would
   * only surface at delivery.
   */
  async authority(context: StackContext): Promise<DownstreamAuthority> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.status !== 'LOCKED') {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_LOCKED, 422);
    }

    if (!snapshot.baselineId || !snapshot.baselineVersion || !snapshot.lockedAt) {
      throw new StackError(STACK_ERROR_CODES.BASELINE_NOT_APPROVED, 422);
    }

    const components = await this.repository.listComponents(context.projectId, snapshot.version);
    const live = components.filter(
      (component) => component.status !== 'REJECTED' && component.status !== 'SUPERSEDED',
    );
    const plan = (snapshot.categoryPlan ?? []) as unknown as CategoryApplicabilityEntry[];
    const filled = new Set(live.map((component) => component.category));

    return {
      contractVersion: DOWNSTREAM_AUTHORITY_VERSION,
      projectId: context.projectId,
      stackSnapshotId: snapshot.snapshotId,
      stackVersion: snapshot.version,
      lockedAt: snapshot.lockedAt.toISOString(),
      baselineId: snapshot.baselineId,
      baselineVersion: snapshot.baselineVersion,
      projectTypes: snapshot.projectTypes as ProjectType[],
      technologies: live.map((component) => {
        const version = component.version as { source: string; value?: string };

        return {
          category: component.category as TechnologyCategory,
          ...(component.technologyId ? { technologyId: component.technologyId } : {}),
          technologyName: component.technologyName,
          ...(version.value ? { version: version.value } : {}),
          authority: authorityOf(component.status as StackComponentStatus),
          ...(component.selectionSource
            ? { selectionSource: component.selectionSource as 'USER' }
            : {}),
          mandatory: component.mandatory,
          licence: component.licence,
          costPosture: component.costPosture as 'UNKNOWN',
          selfHostable: component.selfHostable,
          requirementIds: [
            ...((component.evidence as { requirementIds?: string[] }).requirementIds ?? []),
          ],
        };
      }),
      /*
       * Categories deliberately left empty, stated as such. A downstream phase
       * that finds no cache here must read "there is no cache", never "pick
       * one" — and saying so explicitly is what makes that unambiguous.
       */
      excludedCategories: plan
        .filter((entry) => entry.applicability !== 'not_applicable' && !filled.has(entry.category))
        .map((entry) => ({
          category: entry.category,
          reason: 'No technology was chosen for this, deliberately.',
        })),
      acknowledgedRisks: live.flatMap((component) =>
        (component.riskAcknowledgements as { summary: string; note: string }[]).map((ack) => ({
          summary: ack.summary,
          technologyName: component.technologyName,
          note: ack.note,
        })),
      ),
    };
  }

  /* -------------------------------------------------- internal helpers */

  /** Everything the UI and every write path needs, computed fresh. */
  async assemble(context: StackContext, snapshot: StackSnapshotDocument): Promise<StackView> {
    const components = await this.repository.listComponents(context.projectId, snapshot.version);
    const project = await this.projects.findByProjectId(context.projectId);
    const projectTypes = (project?.projectTypes ?? []) as ProjectType[];
    const baseline = await this.approvedBaseline(context);
    const plan = await this.planFor(context, snapshot);
    const constraints = await this.constraintsFor(context, baseline?.itemIds ?? []);

    const facts: ComponentFacts[] = components.map((component) => ({
      id: component.componentId,
      category: component.category as TechnologyCategory,
      technologyName: component.technologyName,
      entry: component.technologyId ? findTechnology(component.technologyId) : undefined,
      active: component.status !== 'REJECTED' && component.status !== 'SUPERSEDED',
    }));

    const justified = plan
      .filter((entry) => entry.justifiedBy.length > 0)
      .map((entry) => entry.category);

    const findings = evaluateCompatibility({
      projectTypes: snapshot.projectTypes as ProjectType[],
      components: facts,
      constraints,
      requiredCategories: requiredCategories(plan),
      justifiedCategories: justified,
    });

    const blockers = calculateStackBlockers({
      components: components.map((component) => ({
        id: component.componentId,
        category: component.category as TechnologyCategory,
        technologyName: component.technologyName,
        status: component.status as StackComponentStatus,
        acknowledgedFindingIds: (component.riskAcknowledgements as { findingId: string }[]).map(
          (ack) => ack.findingId,
        ),
      })),
      requiredCategories: requiredCategories(plan),
      findings,
      baselineApproved: Boolean(baseline),
      baselineCurrent: this.baselineIsCurrent(snapshot, baseline),
      projectTypeConfirmed: projectTypeIsActionable(projectTypes),
    });

    return {
      snapshot: {
        ...toSnapshot(snapshot, components.map(toComponent)),
        categoryPlan: plan,
        compatibilityFindings: [...findings],
        highestRisk: highestRisk(findings),
        blockers: [...blockers],
      },
      catalogVersion: CATALOG_VERSION,
    };
  }

  /**
   * Recompute everything, store what belongs on the snapshot, and record the
   * decision that got us here.
   *
   * Called after every change. Findings and blockers are derived, so storing
   * them is a cache — but a cache the approval endpoint reads, so it is written
   * in the same operation as the change that invalidated it.
   */
  private async recalculate(
    context: StackContext,
    snapshot: StackSnapshotDocument,
    kind: StackDecisionKind,
    detail: {
      category?: string;
      technologyName?: string;
      previousTechnologyName?: string;
      note: string;
    },
  ): Promise<StackView> {
    const fresh = await this.repository.currentSnapshot(context.projectId);
    const target = fresh ?? snapshot;
    const view = await this.assemble(context, target);
    const status = nextStatus(target.status as StackSnapshotStatus, view.snapshot.blockers.length);

    const updated = await this.repository.updateSnapshot(
      context.projectId,
      target.snapshotId,
      target.recordVersion,
      {
        status,
        compatibilityFindings: [...view.snapshot.compatibilityFindings],
        highestRisk: view.snapshot.highestRisk,
        blockers: [...view.snapshot.blockers],
        categoryPlan: [...view.snapshot.categoryPlan],
        decisions: [...target.decisions, decision(kind, detail)],
      },
    );

    return updated ? this.assemble(context, updated) : view;
  }

  /** The snapshot, refusing if it is sealed or the caller is out of date. */
  async editableSnapshot(
    context: StackContext,
    expectedVersion: number,
  ): Promise<StackSnapshotDocument> {
    return this.editable(context, expectedVersion);
  }

  private async editable(
    context: StackContext,
    expectedVersion: number,
    options: { allowLocked?: boolean } = {},
  ): Promise<StackSnapshotDocument> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.status === 'LOCKED' && !options.allowLocked) {
      throw new StackError(STACK_ERROR_CODES.STACK_LOCKED, 409);
    }

    if (snapshot.recordVersion !== expectedVersion) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 409, 'version_conflict');
    }

    return snapshot;
  }

  private async snapshotOr404(context: StackContext): Promise<StackSnapshotDocument> {
    const snapshot = await this.repository.currentSnapshot(context.projectId);

    if (!snapshot) {
      throw new StackError(STACK_ERROR_CODES.STACK_NOT_FOUND, 404);
    }

    return snapshot;
  }

  private async componentOr404(
    context: StackContext,
    componentId: string,
  ): Promise<StackComponentDocument> {
    const component = await this.repository.findComponent(context.projectId, componentId);

    if (!component) {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_NOT_FOUND, 404);
    }

    return component;
  }

  private async transition(
    context: StackContext,
    component: StackComponentDocument,
    to: StackComponentStatus,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const updated = await this.repository.updateComponent(
      context.projectId,
      component.componentId,
      component.recordVersion,
      { status: to, authority: authorityOf(to), ...changes },
    );

    if (!updated) {
      throw new StackError(STACK_ERROR_CODES.COMPONENT_NOT_FOUND, 409, 'version_conflict');
    }
  }

  /**
   * The first snapshot for a project.
   *
   * Records the project types as they stand now, which is what a later change
   * is compared against.
   */
  private async createInitial(context: StackContext): Promise<StackSnapshotDocument> {
    const project = await this.projects.findByProjectId(context.projectId);
    const projectTypes = (project?.projectTypes ?? []) as ProjectType[];
    const baseline = await this.approvedBaseline(context);

    return this.repository.createSnapshot({
      snapshotId: StackRepository.newId('stk'),
      projectId: context.projectId,
      version: await this.repository.nextSnapshotVersion(context.projectId),
      status: 'DRAFT',
      selectionMode: 'HYBRID',
      ...(baseline ? { baselineId: baseline.baselineId, baselineVersion: baseline.version } : {}),
      projectTypes: [...projectTypes],
      categoryPlan: [...planCategories(projectTypes)],
      componentIds: [],
      compatibilityFindings: [],
      highestRisk: 'NONE',
      blockers: [],
      decisions: [],
    });
  }

  /**
   * The category plan, with conditional categories justified by requirements.
   *
   * The justification is a keyword match against approved requirement text, and
   * it is deliberately conservative: a category nothing matches stays
   * conditional, which means it is neither offered nor counted as missing.
   */
  async planFor(
    context: StackContext,
    snapshot: StackSnapshotDocument,
  ): Promise<CategoryApplicabilityEntry[]> {
    const plan = planCategories(snapshot.projectTypes as ProjectType[]);
    const baseline = await this.approvedBaseline(context);

    if (!baseline) {
      return [...plan];
    }

    const items = await this.analysis.findItemsByIds(context.projectId, baseline.itemIds);
    const justifications = new Map<TechnologyCategory, string[]>();

    for (const item of items) {
      const text = `${item.title} ${item.statement}`.toLowerCase();

      for (const [category, keywords] of CONDITIONAL_KEYWORDS) {
        if (keywords.some((keyword) => text.includes(keyword))) {
          justifications.set(category, [...(justifications.get(category) ?? []), item.itemId]);
        }
      }
    }

    return plan.map((entry) => {
      const justifiedBy = justifications.get(entry.category);

      if (entry.applicability !== 'conditional' || !justifiedBy) {
        return entry;
      }

      return {
        ...entry,
        applicability: 'optional' as const,
        reason: 'Something in your approved requirements asks for this.',
        justifiedBy,
      };
    });
  }

  /** Constraints derived from the approved requirements plus what was entered. */
  private async constraintsFor(
    context: StackContext,
    itemIds: readonly string[],
  ): Promise<StackConstraints> {
    if (itemIds.length === 0) {
      return EMPTY_CONSTRAINTS;
    }

    const items = await this.analysis.findItemsByIds(context.projectId, itemIds);

    return deriveConstraints(
      items.map((item) => ({
        itemId: item.itemId,
        title: item.title,
        description: item.statement,
        status: item.status,
      })),
    );
  }

  private async approvedBaseline(
    context: StackContext,
  ): Promise<{ baselineId: string; version: number; itemIds: string[]; current: boolean } | null> {
    /*
     * Asked through the service, not the repository.
     *
     * Whether an approved baseline has gone out of date is evaluated lazily,
     * when somebody reads it. Reading the collection directly would skip that
     * check and the stack would go on believing its requirements were current
     * long after a document changed — which is the failure this phase's
     * outdated-propagation rule exists to prevent.
     */
    await this.baselines.propagateOutdated(context.projectId, new Date(), context.correlationId);

    const baselines = await this.analysis.listBaselines(context.projectId);
    /*
     * An outdated baseline is still the approved one — it says exactly what it
     * said when it was signed. It is returned with `current: false`, which
     * becomes a blocker rather than a refusal to show anything, so the user can
     * see their stack while knowing the ground under it moved.
     */
    const approved = baselines.find(
      (baseline) => baseline.status === 'approved' || baseline.status === 'outdated',
    );

    if (!approved) {
      return null;
    }

    return {
      baselineId: approved.baselineId,
      version: approved.version,
      itemIds: [...approved.itemIds],
      current: approved.status === 'approved',
    };
  }

  /**
   * Whether the stack still stands on the baseline it was decided against.
   *
   * A stack built on baseline v1 while v2 is approved is out of date, and so is
   * one whose baseline has itself gone out of date. Neither is silently
   * regenerated — the user decides what to do about it.
   */
  private baselineIsCurrent(
    snapshot: StackSnapshotDocument,
    baseline: { version: number; current: boolean } | null,
  ): boolean {
    if (!baseline) {
      return false;
    }

    if (!snapshot.baselineVersion) {
      return baseline.current;
    }

    return baseline.current && snapshot.baselineVersion === baseline.version;
  }

  /** Resolve a request's technology to a catalogue entry, or keep it custom. */
  private resolveTechnology(request: { technologyId?: string; customName?: string }): {
    entry: CatalogEntry | undefined;
    name: string;
  } {
    if (request.technologyId) {
      const entry = findTechnology(request.technologyId);

      if (!entry) {
        throw new StackError(STACK_ERROR_CODES.UNKNOWN_TECHNOLOGY, 422);
      }

      return { entry, name: entry.name };
    }

    const typed = (request.customName ?? '').trim();

    /*
     * A typed name that matches the catalogue resolves to it, so "postgres"
     * inherits the reviewed licence and cost facts rather than becoming a
     * custom entry with none. Anything else stays exactly as typed —
     * authoritative, and honestly labelled as carrying no reviewed facts.
     */
    const matched = resolveByName(typed);

    return { entry: matched, name: matched?.name ?? typed };
  }

  /** Every cited requirement has to exist in this project's baseline. */
  private async assertRequirementsExist(
    context: StackContext,
    requirementIds: readonly string[],
  ): Promise<void> {
    if (requirementIds.length === 0) {
      return;
    }

    const items = await this.analysis.findItemsByIds(context.projectId, requirementIds);

    if (items.length !== new Set(requirementIds).size) {
      throw new StackError(STACK_ERROR_CODES.UNKNOWN_REQUIREMENT, 422);
    }
  }

  private strengthAfterAcceptance(component: StackComponentDocument): number {
    const evidence = component.evidence as {
      kind: string;
      requirementIds?: string[];
      clarificationKeys?: string[];
    };

    return calculateStackEvidence({
      evidenceKind: evidence.kind as 'CLIENT_REQUIREMENT',
      requirementIds: evidence.requirementIds ?? [],
      clarificationKeys: evidence.clarificationKeys ?? [],
      mandatedByRequirement: component.mandatory,
      satisfiesStatedConstraint: false,
      userSelected: true,
      inCatalog: Boolean(component.technologyId),
      hasOpenConflict: false,
      missingInfrastructureContext: false,
    }).score;
  }
}

/**
 * Keywords that make a conditional category applicable.
 *
 * Deliberately narrow. The failure this guards against is a stack that grows a
 * cache because a requirement mentioned "fast" — so the keywords name the thing
 * itself, or a requirement that unambiguously implies it. A category nothing
 * matches stays conditional, which means it is neither offered nor missing.
 */
const CONDITIONAL_KEYWORDS: readonly [TechnologyCategory, readonly string[]][] = [
  ['cache', ['cache', 'caching']],
  ['search', ['full-text search', 'search the catalogue', 'faceted search', 'search index']],
  [
    'vector_storage',
    ['semantic search', 'similarity search', 'retrieval-augmented', 'embedding', 'vector search'],
  ],
  ['message_queue', ['message queue', 'event stream', 'publish and subscribe', 'message broker']],
  ['api_gateway', ['api gateway', 'rate limit', 'rate-limit']],
  ['realtime', ['real time', 'real-time', 'live update', 'websocket', 'push notification']],
  ['containerization', ['container', 'docker', 'kubernetes', 'orchestration']],
  ['data_processing', ['etl', 'data pipeline', 'batch processing', 'transform the data']],
];

/** A stack with blockers needs review; one without is ready. */
function nextStatus(current: StackSnapshotStatus, blockerCount: number): StackSnapshotStatus {
  if (current === 'LOCKED' || current === 'SUPERSEDED') {
    return current;
  }

  if (current === 'APPROVED' || current === 'OUTDATED') {
    return current;
  }

  return blockerCount === 0 ? 'READY_FOR_APPROVAL' : 'REVIEW_REQUIRED';
}

function decision(
  kind: StackDecisionKind,
  detail: {
    category?: string;
    technologyName?: string;
    previousTechnologyName?: string;
    note: string;
  },
): StackDecision {
  return {
    kind,
    ...(detail.category ? { category: detail.category } : {}),
    ...(detail.technologyName ? { technologyName: detail.technologyName } : {}),
    ...(detail.previousTechnologyName
      ? { previousTechnologyName: detail.previousTechnologyName }
      : {}),
    note: detail.note,
    decidedAt: new Date().toISOString(),
  };
}

export interface StackView {
  readonly snapshot: StackSnapshot;
  readonly catalogVersion: string;
}

export interface CatalogView {
  readonly catalogVersion: string;
  readonly entries: readonly CatalogEntry[];
}

/** Re-exported so the recommendation service and tests share one definition. */
export { aiMayReplace, isDecided, type TechnologyMandate, type StackComponent };
