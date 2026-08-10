import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  DEFAULT_CALENDAR,
  ESTIMATION_ERROR_CODES,
  ESTIMATION_LIMITS,
  EMPTY_TEAM,
  MILESTONE_LABELS,
  NO_EXISTING_SYSTEM,
  PRODUCTIVITY_MODEL_VERSION,
  aggregateEffort,
  applicableRoles,
  assessFeasibility,
  buildSchedule,
  calculateCapacity,
  calculateEstimateBlockers,
  canApproveEstimate,
  deriveComplexity,
  deriveUncertainty,
  describeTimeline,
  feasibilityNeedsAcknowledgement,
  hasCalendarDate,
  isMaterialCalendarChange,
  isMaterialCapacityChange,
  isPlausibleHours,
  isUserAuthored,
  rangeFor,
  recommendStaffing,
  sumRoleEffort,
  timelineWorkingDays,
  validateDeadlineAgainstStart,
  totalRoleEffort,
  validateDependencies,
  type AcknowledgeFeasibility,
  type ApproveEstimate,
  type CapacityLine,
  type ComplexityDriver,
  type ComplexityLevel,
  type CreateDependency,
  type Dependency,
  type EstimateSnapshot,
  type EstimateUnit,
  type ExistingSystem,
  type ManualEstimate,
  type Milestone,
  type OverrideEstimate,
  type ProjectType,
  type ReopenEstimate,
  type RoleEffort,
  type RoleKey,
  type StartDate,
  type TaskCategory,
  type TeamPlan,
  type Timeline,
  type UncertaintyLevel,
  type UncertaintySource,
  type WorkingCalendar,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { ProjectRepository } from '../projects/project.repository';
import { AnalysisRepository } from '../analysis/analysis.repository';
import { BaselineService } from '../analysis/baseline.service';
import { StackRepository } from '../stack/stack.repository';
import { EstimationError } from './estimation.errors';
import { EstimationRepository } from './estimation.repository';
import { toDependency, toSnapshot, toUnit } from './estimation.mapper';
import {
  estimateUnit,
  overheadUnits,
  type EstimateDraft,
  type StackContextInput,
} from './estimation-engine';
import type {
  EstimateDependencyRecord,
  EstimateSnapshotDocument,
  EstimateUnitDocument,
} from './schemas/estimation.schema';

export interface EstimationContext {
  readonly projectId: string;
  readonly correlationId: string;
}

/**
 * The estimation workflow, from an approved baseline and a locked stack to an
 * approved plan.
 *
 * Four commitments run through every method, and each exists because breaking
 * it produces a plan somebody would commit to and miss.
 *
 * **Effort, duration and capacity stay separate.** Effort comes from the
 * estimate lines; capacity from the team and the calendar; duration from the
 * scheduler walking the dependency graph. Nothing here divides hours by a day
 * length and calls the result a delivery date.
 *
 * **The user's timeline is never changed.** Where the work does not fit, that is
 * a feasibility status, a gap in hours and a list of risks — and then it is
 * their decision. There is no code path that extends a deadline.
 *
 * **A user override survives everything.** Re-estimation deletes only units the
 * application authored; the storage filter, not a service-level check, is what
 * makes that true. `USER_OVERRIDE` is never in the delete set.
 *
 * **Locked technologies are priced, never replaced.** The estimator reads the
 * locked stack and may add hours because of it. It has no path to changing it.
 */
@Injectable()
export class EstimationService {
  constructor(
    private readonly repository: EstimationRepository,
    private readonly analysis: AnalysisRepository,
    private readonly baselines: BaselineService,
    private readonly stacks: StackRepository,
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
  ) {}

  /* --------------------------------------------------------- reading */

  /** The current estimate, created empty on first read. */
  async current(context: EstimationContext): Promise<EstimateView> {
    const existing = await this.repository.currentSnapshot(context.projectId);
    const snapshot = existing ?? (await this.createInitial(context));

    return this.assemble(context, snapshot);
  }

  async listVersions(context: EstimationContext): Promise<EstimateSnapshot[]> {
    const snapshots = await this.repository.listSnapshots(context.projectId);
    const views: EstimateSnapshot[] = [];

    for (const snapshot of snapshots) {
      const units = await this.repository.listUnits(context.projectId, snapshot.version);
      const dependencies = await this.repository.listDependencies(
        context.projectId,
        snapshot.version,
      );

      views.push(toSnapshot(snapshot, units.map(toUnit), dependencies.map(toDependency)));
    }

    return views;
  }

  async version(context: EstimationContext, version: number): Promise<EstimateSnapshot> {
    const snapshot = await this.repository.findSnapshot(context.projectId, version);

    if (!snapshot) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 404);
    }

    const units = await this.repository.listUnits(context.projectId, version);
    const dependencies = await this.repository.listDependencies(context.projectId, version);

    return toSnapshot(snapshot, units.map(toUnit), dependencies.map(toDependency));
  }

  /* --------------------------------------------------------- estimating */

  /**
   * Produce estimate lines for every approved requirement that has none.
   *
   * The deterministic path, and the one that runs whether or not a model is
   * available. `proposals` carries whatever a model suggested — categories,
   * complexities, drivers — and every one of them is fed back through the same
   * arithmetic, so the hours are always the application's.
   */
  async generate(
    context: EstimationContext,
    snapshot: EstimateSnapshotDocument,
    proposals: ReadonlyMap<string, ModelProposal> = new Map(),
  ): Promise<{ readonly produced: number; readonly preserved: number }> {
    const upstream = await this.upstream(context);

    if (!upstream.baseline) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.BASELINE_NOT_APPROVED, 422);
    }

    if (!upstream.stack) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.STACK_NOT_LOCKED, 422);
    }

    const existing = await this.repository.listUnits(context.projectId, snapshot.version);
    const preserved = existing.filter((unit) =>
      isUserAuthored(unit.source as EstimateUnit['source']),
    );

    /*
     * Only the application's own lines are removed. A user override is not in
     * the delete filter at all, so no ordering mistake here can lose one.
     */
    await this.repository.deleteReplaceableUnits(context.projectId, snapshot.version);
    await this.repository.deleteReplaceableDependencies(context.projectId, snapshot.version);

    const claimed = new Set(preserved.flatMap((unit) => unit.requirementIds));
    const items = await this.analysis.findItemsByIds(context.projectId, upstream.baseline.itemIds);
    const stackContext = upstream.stackContext;

    const drafts: EstimateDraft[] = [];

    for (const item of items) {
      if (item.status === 'rejected' || item.status === 'superseded' || claimed.has(item.itemId)) {
        continue;
      }

      drafts.push(
        estimateUnit(
          {
            itemId: item.itemId,
            title: item.title,
            statement: item.statement,
            category: item.category,
            ...(item.nfrDimension ? { nfrDimension: item.nfrDimension } : {}),
          },
          stackContext,
          proposals.get(item.itemId) ?? {},
        ),
      );
    }

    /*
     * Overhead is sized from the implementation work, including the hours in
     * user-authored lines — a person overriding a feature upwards should see
     * the review and regression that come with it move too.
     */
    const implementationHours =
      drafts.reduce((total, draft) => total + draft.totalHours, 0) +
      preserved.reduce((total, unit) => total + unit.totalHours, 0);

    drafts.push(...overheadUnits(implementationHours, stackContext.roles));

    if (preserved.length + drafts.length > ESTIMATION_LIMITS.maxEstimateUnits) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_LIMIT_REACHED, 422);
    }

    let sequence = preserved.length;

    await this.repository.insertUnits(
      drafts.map((draft) => {
        sequence += 1;

        return {
          unitId: EstimationRepository.newId('est'),
          projectId: context.projectId,
          estimateVersion: snapshot.version,
          key: `E-${String(sequence).padStart(3, '0')}`,
          requirementIds: [...draft.requirementIds],
          module: draft.module,
          submodule: draft.submodule,
          feature: draft.feature,
          taskCategory: draft.taskCategory,
          ...(draft.overheadActivity ? { overheadActivity: draft.overheadActivity } : {}),
          complexity: draft.complexity,
          complexityDrivers: [...draft.complexityDrivers],
          complexityExplanation: draft.complexityExplanation,
          uncertainty: draft.uncertainty,
          uncertaintySources: [...draft.uncertaintySources],
          uncertaintyExplanation: draft.uncertaintyExplanation,
          effort: draft.effort,
          totalHours: draft.totalHours,
          range: draft.range,
          drivers: draft.drivers as unknown as Record<string, unknown>[],
          rationale: draft.rationale,
          source:
            proposals.size > 0 && draft.requirementIds.length > 0
              ? 'AI_PROPOSED'
              : 'SYSTEM_CALCULATED',
          excluded: false,
        };
      }),
    );

    await this.generateDependencies(context, snapshot.version);

    return { produced: drafts.length, preserved: preserved.length };
  }

  /**
   * The dependencies the application can infer without a model.
   *
   * Deliberately few, and every one a fact rather than a guess: shared
   * architecture comes before what sits on it, and testing comes after the thing
   * being tested. Anything richer is the user's to add — a graph nobody can read
   * is worse than a sparse one.
   */
  private async generateDependencies(
    context: EstimationContext,
    estimateVersion: number,
  ): Promise<void> {
    const units = await this.repository.listUnits(context.projectId, estimateVersion);
    const existing = await this.repository.listDependencies(context.projectId, estimateVersion);
    const known = new Set(existing.map((edge) => `${edge.predecessorId}->${edge.successorId}`));

    const foundation = units.find((unit) => unit.overheadActivity === 'shared_architecture');
    const regression = units.find((unit) => unit.overheadActivity === 'qa_regression');
    const features = units.filter((unit) => !unit.overheadActivity);

    const edges: Partial<EstimateDependencyRecord>[] = [];

    const add = (
      predecessorId: string,
      successorId: string,
      reason: Dependency['reason'],
    ): void => {
      if (predecessorId === successorId || known.has(`${predecessorId}->${successorId}`)) {
        return;
      }

      known.add(`${predecessorId}->${successorId}`);
      edges.push({
        dependencyId: EstimationRepository.newId('dep'),
        projectId: context.projectId,
        estimateVersion,
        predecessorId,
        successorId,
        type: 'FINISH_TO_START',
        reason,
        lagDays: 0,
        userDefined: false,
      });
    };

    for (const feature of features) {
      if (foundation) {
        add(foundation.unitId, feature.unitId, 'shared_architecture');
      }

      if (regression) {
        add(feature.unitId, regression.unitId, 'test_target');
      }
    }

    await this.repository.insertDependencies(edges);
  }

  /* ---------------------------------------------------------- overrides */

  /**
   * Change a figure by hand.
   *
   * The original is kept, so "reset to the calculated figure" needs no re-run —
   * and so the record shows both what was proposed and what was decided.
   */
  async override(
    context: EstimationContext,
    unitId: string,
    request: OverrideEstimate,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const unit = await this.unitOr404(context, unitId);

    if (request.effort) {
      for (const hours of Object.values(request.effort)) {
        if (!isPlausibleHours(hours)) {
          throw new EstimationError(ESTIMATION_ERROR_CODES.IMPLAUSIBLE_HOURS, 422);
        }
      }
    }

    const effort = request.effort ? { ...unit.effort, ...request.effort } : unit.effort;
    const totalHours = totalRoleEffort(effort);
    const complexity = (request.complexity ?? unit.complexity) as ComplexityLevel;
    const drivers = (request.complexityDrivers ?? unit.complexityDrivers) as ComplexityDriver[];
    const sources = (request.uncertaintySources ?? unit.uncertaintySources) as UncertaintySource[];
    const uncertainty = request.uncertainty ?? deriveUncertainty(sources).level;

    const updated = await this.repository.updateUnit(
      context.projectId,
      unitId,
      unit.recordVersion,
      {
        effort,
        totalHours,
        range: rangeFor(totalHours, uncertainty),
        complexity,
        complexityDrivers: drivers,
        complexityExplanation: deriveComplexity(drivers).explanation,
        uncertainty,
        uncertaintySources: sources,
        uncertaintyExplanation: deriveUncertainty(sources).explanation,
        source: 'USER_OVERRIDE',
        // Captured once, on the first override. A second override must not
        // overwrite the original with the first override's figures.
        ...(unit.originalEffort
          ? {}
          : { originalEffort: { ...unit.effort }, originalTotalHours: unit.totalHours }),
        ...(request.note ? { overrideNote: request.note } : {}),
        ...(request.excluded !== undefined ? { excluded: request.excluded } : {}),
        ...(request.exclusionReason ? { exclusionReason: request.exclusionReason } : {}),
      },
    );

    if (!updated) {
      throw new EstimationError(
        ESTIMATION_ERROR_CODES.ESTIMATE_UNIT_NOT_FOUND,
        409,
        'version_conflict',
      );
    }

    await this.audit.record({
      type: 'ESTIMATE_OVERRIDDEN',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { key: unit.key, totalHours, excluded: request.excluded ?? unit.excluded },
    });

    return this.recalculate(context, snapshot);
  }

  /** Put a figure back to what the application calculated. */
  async reset(
    context: EstimationContext,
    unitId: string,
    expectedVersion: number,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, expectedVersion);
    const unit = await this.unitOr404(context, unitId);

    if (!unit.originalEffort) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_UNIT_NOT_FOUND, 422);
    }

    const effort = { ...unit.originalEffort };
    const totalHours = unit.originalTotalHours ?? totalRoleEffort(effort);

    await this.repository.updateUnit(
      context.projectId,
      unitId,
      unit.recordVersion,
      {
        effort,
        totalHours,
        range: rangeFor(totalHours, unit.uncertainty as UncertaintyLevel),
        source: 'SYSTEM_CALCULATED',
      },
      ['originalEffort', 'originalTotalHours', 'overrideNote'],
    );

    return this.recalculate(context, snapshot);
  }

  /** Add a line by hand. The path that works with no inference at all. */
  async addManual(context: EstimationContext, request: ManualEstimate): Promise<EstimateView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const upstream = await this.upstream(context);

    for (const [role, hours] of Object.entries(request.effort)) {
      if (!isPlausibleHours(hours)) {
        throw new EstimationError(ESTIMATION_ERROR_CODES.IMPLAUSIBLE_HOURS, 422);
      }

      if (!upstream.stackContext.roles.includes(role)) {
        throw new EstimationError(ESTIMATION_ERROR_CODES.ROLE_NOT_APPLICABLE, 422);
      }
    }

    await this.assertRequirementsExist(context, request.requirementIds ?? []);

    if (
      (await this.repository.countUnits(context.projectId, snapshot.version)) >=
      ESTIMATION_LIMITS.maxEstimateUnits
    ) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_LIMIT_REACHED, 422);
    }

    const drivers = request.complexityDrivers ?? [];
    const sources = request.uncertaintySources ?? [];
    const totalHours = totalRoleEffort(request.effort);
    const sequence = await this.repository.nextUnitSequence(context.projectId, snapshot.version);

    await this.repository.createUnit({
      unitId: EstimationRepository.newId('est'),
      projectId: context.projectId,
      estimateVersion: snapshot.version,
      key: `E-${String(sequence).padStart(3, '0')}`,
      requirementIds: request.requirementIds ?? [],
      module: request.module ?? '',
      submodule: request.submodule ?? '',
      feature: request.feature,
      taskCategory: request.taskCategory,
      complexity: request.complexity,
      complexityDrivers: drivers,
      complexityExplanation: deriveComplexity(drivers).explanation,
      uncertainty: request.uncertainty,
      uncertaintySources: sources,
      uncertaintyExplanation: deriveUncertainty(sources).explanation,
      effort: request.effort,
      totalHours,
      range: rangeFor(totalHours, request.uncertainty),
      drivers: [],
      rationale: request.rationale ?? 'Added by hand.',
      // A hand-written line is the user's from the moment it exists, so a later
      // re-estimation leaves it alone.
      source: 'USER_OVERRIDE',
      excluded: false,
    });

    return this.recalculate(context, snapshot);
  }

  /* -------------------------------------------------------- dependencies */

  async addDependency(
    context: EstimationContext,
    request: CreateDependency,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const units = await this.repository.listUnits(context.projectId, snapshot.version);
    const known = new Set(units.map((unit) => unit.unitId));

    if (!known.has(request.predecessorId) || !known.has(request.successorId)) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.UNKNOWN_TASK, 422);
    }

    const existing = await this.repository.listDependencies(context.projectId, snapshot.version);

    /*
     * Checked before it is written, not after. A cycle stored and then reported
     * would leave the project unschedulable until somebody removed it; refusing
     * the write keeps the graph always valid.
     */
    const problems = validateDependencies({
      dependencies: [
        ...existing.map(toDependency),
        {
          id: 'pending',
          predecessorId: request.predecessorId,
          successorId: request.successorId,
          type: request.type,
          reason: request.reason,
          lagDays: request.lagDays,
          userDefined: true,
        },
      ],
      taskIds: units.map((unit) => unit.unitId),
      excludedTaskIds: units.filter((unit) => unit.excluded).map((unit) => unit.unitId),
    });

    if (problems.some((problem) => problem.kind === 'cycle' || problem.kind === 'self_reference')) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.DEPENDENCY_CYCLE, 422);
    }

    await this.repository.createDependency({
      dependencyId: EstimationRepository.newId('dep'),
      projectId: context.projectId,
      estimateVersion: snapshot.version,
      predecessorId: request.predecessorId,
      successorId: request.successorId,
      type: request.type,
      reason: request.reason,
      lagDays: request.lagDays,
      userDefined: true,
      ...(request.note ? { note: request.note } : {}),
    });

    await this.audit.record({
      type: 'DEPENDENCY_CHANGED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { action: 'added', type: request.type },
    });

    return this.recalculate(context, snapshot);
  }

  async removeDependency(
    context: EstimationContext,
    dependencyId: string,
    expectedVersion: number,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, expectedVersion);
    const removed = await this.repository.deleteDependency(context.projectId, dependencyId);

    if (!removed) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.DEPENDENCY_NOT_FOUND, 404);
    }

    await this.audit.record({
      type: 'DEPENDENCY_CHANGED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { action: 'removed' },
    });

    return this.recalculate(context, snapshot);
  }

  /* ------------------------------------------------- calendar and team */

  async setCalendar(
    context: EstimationContext,
    calendar: WorkingCalendar,
    expectedVersion: number,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, expectedVersion);
    const before = snapshot.calendar as unknown as WorkingCalendar;

    await this.repository.updateSnapshot(context.projectId, snapshot.snapshotId, expectedVersion, {
      calendar: calendar,
    });

    await this.audit.record({
      type: 'CALENDAR_CHANGED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { material: isMaterialCalendarChange(before, calendar) },
    });

    return this.recalculate(context, snapshot);
  }

  async setTeam(
    context: EstimationContext,
    lines: readonly CapacityLine[],
    expectedVersion: number,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, expectedVersion);
    const upstream = await this.upstream(context);

    for (const line of lines) {
      if (!upstream.stackContext.roles.includes(line.role)) {
        throw new EstimationError(ESTIMATION_ERROR_CODES.ROLE_NOT_APPLICABLE, 422);
      }
    }

    const before = snapshot.team as unknown as TeamPlan;
    const team: TeamPlan = { supplied: lines.length > 0, lines: [...lines] };

    await this.repository.updateSnapshot(context.projectId, snapshot.snapshotId, expectedVersion, {
      team: team,
    });

    await this.audit.record({
      type: 'TEAM_CAPACITY_CHANGED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { roles: lines.length, material: isMaterialCapacityChange(before, team) },
    });

    return this.recalculate(context, snapshot);
  }

  async setExistingSystem(
    context: EstimationContext,
    existingSystem: ExistingSystem,
    expectedVersion: number,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, expectedVersion);

    await this.repository.updateSnapshot(context.projectId, snapshot.snapshotId, expectedVersion, {
      existingSystem: existingSystem,
    });

    return this.recalculate(context, snapshot);
  }

  /**
   * Recalculate the schedule and nothing else.
   *
   * The operation the start-date rule exists for. The whole schedule is computed
   * in working-day offsets and the date applied at the end, so moving the date
   * moves the dates — the effort, the complexity, the overrides and the
   * dependency graph are not touched, and the approved status survives.
   */
  async recalculateSchedule(
    context: EstimationContext,
    expectedVersion: number,
  ): Promise<EstimateView> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.recordVersion !== expectedVersion) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 409, 'version_conflict');
    }

    const view = await this.assemble(context, snapshot);

    await this.repository.updateSnapshot(
      context.projectId,
      snapshot.snapshotId,
      snapshot.recordVersion,
      {
        schedule: view.snapshot.schedule,
        milestones: view.snapshot.milestones,
        ...(view.snapshot.startDate ? { startDate: view.snapshot.startDate } : {}),
        startDateMode: view.snapshot.startDateMode,
      },
    );

    await this.audit.record({
      type: 'TIMELINE_RECALCULATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { relativeOnly: view.snapshot.schedule.relativeOnly },
    });

    const refreshed = await this.repository.currentSnapshot(context.projectId);

    return this.assemble(context, refreshed ?? snapshot);
  }

  /* ------------------------------------------------- risk and approval */

  async acknowledgeRisk(
    context: EstimationContext,
    request: AcknowledgeFeasibility,
  ): Promise<EstimateView> {
    const snapshot = await this.editable(context, request.expectedVersion);
    const view = await this.assemble(context, snapshot);
    const status = view.snapshot.feasibility.status;

    if (!feasibilityNeedsAcknowledgement(status)) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.NO_RISK_TO_ACKNOWLEDGE, 422);
    }

    await this.repository.updateSnapshot(
      context.projectId,
      snapshot.snapshotId,
      request.expectedVersion,
      {
        riskAcknowledgedAt: new Date(),
        /*
         * The status is stored, not a boolean. Someone who accepted "tight" has
         * not accepted "not possible with this team" — so if the plan degrades,
         * the acknowledgement stops covering it and the blocker returns.
         */
        riskAcknowledgedStatus: status,
        ...(request.note ? { riskAcknowledgementNote: request.note } : {}),
      },
    );

    await this.audit.record({
      type: 'TIMELINE_RISK_ACKNOWLEDGED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { status },
    });

    const refreshed = await this.repository.currentSnapshot(context.projectId);

    return this.assemble(context, refreshed ?? snapshot);
  }

  async approve(context: EstimationContext, request: ApproveEstimate): Promise<EstimateView> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.recordVersion !== request.expectedVersion) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 409, 'version_conflict');
    }

    if (snapshot.status === 'APPROVED') {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_ALREADY_APPROVED, 409);
    }

    const view = await this.assemble(context, snapshot);

    if (!canApproveEstimate(view.snapshot)) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_HAS_BLOCKERS, 422, undefined, {
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
      },
    );

    if (!updated) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'ESTIMATE_APPROVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        version: snapshot.version,
        totalHours: view.snapshot.totalEffort.expected,
        feasibility: view.snapshot.feasibility.status,
      },
    });

    return this.assemble(context, updated);
  }

  /**
   * Reopen an approved estimate as a new version.
   *
   * The approved one is superseded, not edited — it keeps saying what it said,
   * because that is what somebody committed to. Overrides and user-defined
   * dependencies carry forward with their provenance intact.
   */
  async reopen(context: EstimationContext, request: ReopenEstimate): Promise<EstimateView> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.recordVersion !== request.expectedVersion) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 409, 'version_conflict');
    }

    if (snapshot.status !== 'APPROVED' && snapshot.status !== 'OUTDATED') {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_APPROVED, 422);
    }

    const nextVersion = await this.repository.nextSnapshotVersion(context.projectId);
    const idMap = await this.repository.carryUnitsForward(
      context.projectId,
      snapshot.version,
      nextVersion,
    );

    await this.repository.carryDependenciesForward(
      context.projectId,
      snapshot.version,
      nextVersion,
      idMap,
    );

    const created = await this.repository.createSnapshot({
      snapshotId: EstimationRepository.newId('esp'),
      projectId: context.projectId,
      version: nextVersion,
      status: 'DRAFT',
      ...this.upstreamFields(snapshot),
      calendar: snapshot.calendar,
      team: snapshot.team,
      customRoles: snapshot.customRoles,
      existingSystem: snapshot.existingSystem,
      integrations: snapshot.integrations,
      productivityModelVersion: PRODUCTIVITY_MODEL_VERSION,
      mentionAiAssistance: snapshot.mentionAiAssistance,
      milestones: [],
      totalEffort: { optimistic: 0, expected: 0, conservative: 0 },
      effortByRole: {},
      schedule: { tasks: [], totalWorkingDays: 0, criticalPath: [], relativeOnly: true },
      utilisation: [],
      recommendedStaffing: [],
      feasibility: emptyFeasibility(),
      blockers: [],
    });

    await this.repository.supersedeSnapshots(context.projectId, nextVersion, nextVersion);

    await this.audit.record({
      type: 'ESTIMATE_REOPENED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { fromVersion: snapshot.version, toVersion: nextVersion },
    });

    return this.assemble(context, created);
  }

  /* -------------------------------------------------- internal helpers */

  /**
   * Everything computed, from stored data, on every read.
   *
   * The order is the argument of the phase: effort from the lines, capacity
   * from the team and calendar, duration from the scheduler walking the graph,
   * feasibility from all three. No step short-circuits to the next.
   */
  async assemble(
    context: EstimationContext,
    snapshot: EstimateSnapshotDocument,
  ): Promise<EstimateView> {
    const units = await this.repository.listUnits(context.projectId, snapshot.version);
    const dependencyDocs = await this.repository.listDependencies(
      context.projectId,
      snapshot.version,
    );
    const dependencies = dependencyDocs.map(toDependency);
    const upstream = await this.upstream(context);
    const calendar = snapshot.calendar as unknown as WorkingCalendar;
    const team = snapshot.team as unknown as TeamPlan;

    const counted = units.filter((unit) => !unit.excluded);

    /* 1. Effort. */
    const totals = aggregateEffort(
      counted.map((unit) => ({
        range: unit.range as unknown as {
          optimistic: number;
          expected: number;
          conservative: number;
        },
        byRole: unit.effort,
        isImplementation: !unit.overheadActivity,
      })),
    );

    /* 2. Duration, from the graph — never from the hours alone. */
    const peoplePerRole: Record<string, number> = {};

    for (const line of team.lines) {
      peoplePerRole[line.role] = (peoplePerRole[line.role] ?? 0) + line.people;
    }

    const startDate =
      upstream.startDate && hasCalendarDate(upstream.startDate)
        ? upstream.startDate.date
        : undefined;

    const schedule = buildSchedule({
      tasks: counted.map((unit) => ({
        id: unit.unitId,
        role: dominantRole(unit.effort),
        hours: unit.totalHours,
      })),
      dependencies,
      calendar,
      peoplePerRole,
      allowParallel: true,
      ...(startDate ? { startDate } : {}),
    });

    /* 3. Capacity, against the timeline the user set. */
    const availableWorkingDays = upstream.timeline
      ? timelineWorkingDays(upstream.timeline, calendar, startDate)
      : null;

    const capacity = calculateCapacity({
      plannedEffort: totals.byRole,
      team,
      calendar,
      availableWorkingDays,
    });

    /* 4. Feasibility, from all three. */
    const highUncertaintyHours = counted
      .filter((unit) => unit.uncertainty === 'HIGH')
      .reduce((total, unit) => total + unit.totalHours, 0);

    const existingSystem = snapshot.existingSystem as unknown as ExistingSystem;

    const feasibility = assessFeasibility({
      requiredWorkingDays: schedule.totalWorkingDays,
      availableWorkingDays,
      capacity,
      highUncertaintyShare: totals.totalHours === 0 ? 0 : highUncertaintyHours / totals.totalHours,
      criticalPathDays: schedule.totalWorkingDays,
      hasUnassessedCodebase: existingSystem.applies && !existingSystem.repositoryReviewed,
      hasExternalDependency: counted.some((unit) => unit.taskCategory === 'integration'),
      clientReviewBudgeted: calendar.clientReviewDays > 0,
      allowParallel: true,
    });

    const dependencyProblems = validateDependencies({
      dependencies,
      taskIds: units.map((unit) => unit.unitId),
      excludedTaskIds: units.filter((unit) => unit.excluded).map((unit) => unit.unitId),
    });

    const blockers = calculateEstimateBlockers({
      estimates: units.map(toUnit),
      dependencyProblems,
      baselineRequirementIds: upstream.baseline?.itemIds ?? [],
      baselineApproved: Boolean(upstream.baseline),
      baselineCurrent: upstream.baselineCurrent,
      stackLocked: Boolean(upstream.stack),
      stackCurrent: upstream.stackCurrent,
      timelinePresent: Boolean(upstream.timeline),
      deadlinePrecedesStart: !validateDeadlineAgainstStart(upstream.timeline, upstream.startDate)
        .valid,
      feasibilityStatus: feasibility.status,
      ...(snapshot.riskAcknowledgedStatus
        ? { riskAcknowledgedStatus: snapshot.riskAcknowledgedStatus }
        : {}),
    });

    return {
      snapshot: {
        ...toSnapshot(snapshot, units.map(toUnit), dependencies),
        timelineDescription: upstream.timeline ? describeTimeline(upstream.timeline) : 'Not set',
        startDateMode: upstream.startDate?.mode ?? 'NOT_CONFIRMED',
        ...(startDate ? { startDate } : {}),
        totalEffort: totals.range,
        effortByRole: totals.byRole,
        implementationHours: totals.implementationHours,
        overheadHours: totals.overheadHours,
        schedule,
        milestones: deriveMilestones(counted, schedule),
        utilisation: [...capacity.byRole],
        recommendedStaffing: [
          ...recommendStaffing({
            plannedEffort: totals.byRole,
            calendar,
            availableWorkingDays,
          }),
        ],
        feasibility,
        blockers: [...blockers],
      },
      dependencyProblems: [...dependencyProblems],
      applicableRoles: [...upstream.stackContext.roles],
    };
  }

  /** Recompute, store what the approval endpoint reads, and return the view. */
  private async recalculate(
    context: EstimationContext,
    snapshot: EstimateSnapshotDocument,
  ): Promise<EstimateView> {
    const fresh = await this.repository.currentSnapshot(context.projectId);
    const target = fresh ?? snapshot;
    const view = await this.assemble(context, target);

    const status =
      target.status === 'APPROVED' || target.status === 'OUTDATED' || target.status === 'SUPERSEDED'
        ? target.status
        : view.snapshot.blockers.length === 0
          ? 'READY_FOR_APPROVAL'
          : 'REVIEW_REQUIRED';

    const updated = await this.repository.updateSnapshot(
      context.projectId,
      target.snapshotId,
      target.recordVersion,
      {
        status,
        totalEffort: view.snapshot.totalEffort,
        effortByRole: view.snapshot.effortByRole,
        implementationHours: view.snapshot.implementationHours,
        overheadHours: view.snapshot.overheadHours,
        schedule: view.snapshot.schedule,
        milestones: view.snapshot.milestones,
        utilisation: view.snapshot.utilisation,
        recommendedStaffing: view.snapshot.recommendedStaffing,
        feasibility: view.snapshot.feasibility,
        blockers: view.snapshot.blockers,
      },
    );

    return updated ? this.assemble(context, updated) : view;
  }

  async editableSnapshot(
    context: EstimationContext,
    expectedVersion: number,
  ): Promise<EstimateSnapshotDocument> {
    return this.editable(context, expectedVersion);
  }

  private async editable(
    context: EstimationContext,
    expectedVersion: number,
  ): Promise<EstimateSnapshotDocument> {
    const snapshot = await this.snapshotOr404(context);

    if (snapshot.status === 'APPROVED') {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_APPROVED, 409);
    }

    if (snapshot.recordVersion !== expectedVersion) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 409, 'version_conflict');
    }

    return snapshot;
  }

  private async snapshotOr404(context: EstimationContext): Promise<EstimateSnapshotDocument> {
    const snapshot = await this.repository.currentSnapshot(context.projectId);

    if (!snapshot) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_NOT_FOUND, 404);
    }

    return snapshot;
  }

  private async unitOr404(
    context: EstimationContext,
    unitId: string,
  ): Promise<EstimateUnitDocument> {
    const unit = await this.repository.findUnit(context.projectId, unitId);

    if (!unit) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATE_UNIT_NOT_FOUND, 404);
    }

    return unit;
  }

  private async createInitial(context: EstimationContext): Promise<EstimateSnapshotDocument> {
    const upstream = await this.upstream(context);

    return this.repository.createSnapshot({
      snapshotId: EstimationRepository.newId('esp'),
      projectId: context.projectId,
      version: await this.repository.nextSnapshotVersion(context.projectId),
      status: 'DRAFT',
      ...(upstream.baseline
        ? { baselineId: upstream.baseline.baselineId, baselineVersion: upstream.baseline.version }
        : {}),
      ...(upstream.stack
        ? { stackSnapshotId: upstream.stack.snapshotId, stackVersion: upstream.stack.version }
        : {}),
      ...(upstream.timeline ? { timelineDigest: digestTimeline(upstream.timeline) } : {}),
      timelineDescription: upstream.timeline ? describeTimeline(upstream.timeline) : 'Not set',
      startDateMode: upstream.startDate?.mode ?? 'NOT_CONFIRMED',
      calendar: calendarFrom(upstream),
      team: EMPTY_TEAM,
      customRoles: [],
      existingSystem: NO_EXISTING_SYSTEM,
      integrations: [],
      productivityModelVersion: PRODUCTIVITY_MODEL_VERSION,
      mentionAiAssistance: false,
      milestones: [],
      totalEffort: { optimistic: 0, expected: 0, conservative: 0 },
      effortByRole: {},
      schedule: { tasks: [], totalWorkingDays: 0, criticalPath: [], relativeOnly: true },
      utilisation: [],
      recommendedStaffing: [],
      feasibility: emptyFeasibility(),
      blockers: [],
    });
  }

  private upstreamFields(snapshot: EstimateSnapshotDocument): Record<string, unknown> {
    return {
      ...(snapshot.baselineId ? { baselineId: snapshot.baselineId } : {}),
      ...(snapshot.baselineVersion ? { baselineVersion: snapshot.baselineVersion } : {}),
      ...(snapshot.stackSnapshotId ? { stackSnapshotId: snapshot.stackSnapshotId } : {}),
      ...(snapshot.stackVersion ? { stackVersion: snapshot.stackVersion } : {}),
      ...(snapshot.timelineDigest ? { timelineDigest: snapshot.timelineDigest } : {}),
      timelineDescription: snapshot.timelineDescription,
      startDateMode: snapshot.startDateMode,
      ...(snapshot.startDate ? { startDate: snapshot.startDate } : {}),
    };
  }

  /**
   * Everything upstream, read through the services that own it.
   *
   * The baseline goes through `BaselineService` rather than the repository, so
   * Phase 4's lazy outdated check runs — the same fix Phase 5 needed, for the
   * same reason.
   */
  async upstream(context: EstimationContext): Promise<UpstreamState> {
    await this.baselines.propagateOutdated(context.projectId, new Date(), context.correlationId);

    const baselines = await this.analysis.listBaselines(context.projectId);
    const approved = baselines.find(
      (baseline) => baseline.status === 'approved' || baseline.status === 'outdated',
    );

    const stackSnapshot = await this.stacks.currentSnapshot(context.projectId);
    const locked = stackSnapshot?.status === 'LOCKED' ? stackSnapshot : null;
    const components = locked
      ? await this.stacks.listComponents(context.projectId, locked.version)
      : [];

    const project = await this.projects.findByProjectId(context.projectId);
    const projectTypes = (project?.projectTypes ?? []) as ProjectType[];

    const live = components.filter(
      (component) => component.status !== 'REJECTED' && component.status !== 'SUPERSEDED',
    );

    const stackContext: StackContextInput = {
      technologies: live.map((component) => ({
        category: component.category,
        ...(component.technologyId ? { technologyId: component.technologyId } : {}),
        name: component.technologyName,
      })),
      roles: applicableRoles({
        projectTypes,
        stackCategories: live.map((component) => component.category) as never,
      }),
    };

    const snapshot = await this.repository.currentSnapshot(context.projectId);

    return {
      baseline: approved
        ? {
            baselineId: approved.baselineId,
            version: approved.version,
            itemIds: [...approved.itemIds],
            current: approved.status === 'approved',
          }
        : null,
      baselineCurrent:
        approved?.status === 'approved' &&
        (!snapshot?.baselineVersion || snapshot.baselineVersion === approved.version),
      stack: locked ? { snapshotId: locked.snapshotId, version: locked.version } : null,
      stackCurrent:
        Boolean(locked) && (!snapshot?.stackVersion || snapshot.stackVersion === locked?.version),
      stackContext,
      timeline: project?.timeline as Timeline | undefined,
      startDate: project?.startDate as StartDate | undefined,
      teamCapacity: project?.teamCapacity,
    };
  }

  private async assertRequirementsExist(
    context: EstimationContext,
    requirementIds: readonly string[],
  ): Promise<void> {
    if (requirementIds.length === 0) {
      return;
    }

    const items = await this.analysis.findItemsByIds(context.projectId, requirementIds);

    if (items.length !== new Set(requirementIds).size) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.UNKNOWN_REQUIREMENT, 422);
    }
  }
}

/* ------------------------------------------------------------- helpers */

/**
 * The role a task is scheduled under.
 *
 * A line usually spans several roles; the schedule needs one, because that is
 * the resource that contends. The largest share is the right answer — it is the
 * one whose availability actually gates the work.
 */
function dominantRole(effort: RoleEffort): string {
  const entries = Object.entries(effort).sort(([, first], [, second]) => second - first);

  return entries[0]?.[0] ?? 'BACKEND';
}

/**
 * Milestones from the schedule, not from a template.
 *
 * Only the ones this project's work supports: a project with no integrations
 * gets no integration milestone, because a milestone nobody reaches is noise in
 * a plan.
 */
function deriveMilestones(
  units: readonly EstimateUnitDocument[],
  schedule: {
    tasks: readonly { taskId: string; endDay: number; endDate?: string }[];
    totalWorkingDays: number;
  },
): Milestone[] {
  const byId = new Map(schedule.tasks.map((task) => [task.taskId, task]));
  const milestones: Milestone[] = [];

  const add = (kind: Milestone['kind'], taskIds: readonly string[]): void => {
    const relevant = taskIds.map((id) => byId.get(id)).filter((task) => task !== undefined);

    if (relevant.length === 0) {
      return;
    }

    const last = relevant.reduce((latest, task) => (task.endDay > latest.endDay ? task : latest));

    milestones.push({
      id: `ms_${kind}`,
      kind,
      label: MILESTONE_LABELS[kind],
      day: last.endDay,
      ...(last.endDate ? { date: last.endDate } : {}),
      taskIds: [...taskIds],
      userDefined: false,
    });
  };

  add(
    'foundation',
    units
      .filter((unit) => unit.overheadActivity === 'shared_architecture')
      .map((unit) => unit.unitId),
  );
  add(
    'integration_complete',
    units.filter((unit) => unit.taskCategory === 'integration').map((unit) => unit.unitId),
  );
  add(
    'feature_complete',
    units.filter((unit) => !unit.overheadActivity).map((unit) => unit.unitId),
  );
  add(
    'qa_complete',
    units.filter((unit) => unit.overheadActivity === 'qa_regression').map((unit) => unit.unitId),
  );
  add(
    'release_readiness',
    units
      .filter((unit) => unit.overheadActivity === 'deployment_preparation')
      .map((unit) => unit.unitId),
  );

  return milestones.sort((first, second) => first.day - second.day);
}

function calendarFrom(upstream: UpstreamState): WorkingCalendar {
  const capacity = upstream.teamCapacity;

  if (!capacity) {
    return DEFAULT_CALENDAR;
  }

  /*
   * Phase 2 collected working hours and review windows. Carried forward here
   * rather than asked for twice — but the six-and-a-half-hour default stands
   * where the user did not state one.
   */
  return {
    ...DEFAULT_CALENDAR,
    ...(capacity.workingHoursPerDay ? { hoursPerDay: capacity.workingHoursPerDay } : {}),
    ...(capacity.includeWeekends ? { workingWeekdays: [0, 1, 2, 3, 4, 5, 6] } : {}),
    clientReviewDays: capacity.clientReviewDays ?? 0,
    uatDays: capacity.uatDays ?? 0,
    deploymentDays: capacity.deploymentDays ?? 0,
  };
}

/** One string that changes when the timeline does. */
export function digestTimeline(timeline: Timeline): string {
  return createHash('sha256').update(JSON.stringify(timeline)).digest('hex').slice(0, 32);
}

function emptyFeasibility(): Record<string, unknown> {
  return {
    status: 'CAPACITY_UNKNOWN',
    determinacy: 'CONDITIONAL',
    missingInformation: [],
    reason: 'Nothing has been estimated yet.',
    requiredWorkingDays: 0,
    availableWorkingDays: null,
    scheduleGapDays: 0,
    requiredHours: 0,
    availableHours: 0,
    capacityGapHours: 0,
    risks: [],
  };
}

/* --------------------------------------------------------------- types */

export interface ModelProposal {
  readonly proposedCategory?: TaskCategory;
  readonly proposedComplexity?: ComplexityLevel;
  readonly proposedDrivers?: readonly ComplexityDriver[];
  readonly proposedUncertainty?: readonly UncertaintySource[];
  readonly proposedRationale?: string;
}

export interface UpstreamState {
  readonly baseline: {
    readonly baselineId: string;
    readonly version: number;
    readonly itemIds: string[];
    readonly current: boolean;
  } | null;
  readonly baselineCurrent: boolean;
  readonly stack: { readonly snapshotId: string; readonly version: number } | null;
  readonly stackCurrent: boolean;
  readonly stackContext: StackContextInput;
  readonly timeline: Timeline | undefined;
  readonly startDate: StartDate | undefined;
  readonly teamCapacity:
    | {
        workingHoursPerDay?: number;
        includeWeekends?: boolean;
        clientReviewDays?: number;
        uatDays?: number;
        deploymentDays?: number;
      }
    | undefined;
}

export interface EstimateView {
  readonly snapshot: EstimateSnapshot;
  readonly dependencyProblems: readonly ReturnType<typeof validateDependencies>[number][];
  readonly applicableRoles: readonly RoleKey[];
}

export { sumRoleEffort };
