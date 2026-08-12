import { Injectable } from '@nestjs/common';
import {
  OVERHEAD_LABELS,
  TASK_CATEGORY_LABELS,
  calculateWbsCoverage,
  reconcileWbsEffort,
  roundHours,
  validateWbsStructure,
  type EstimateUnit,
  type Milestone,
  type RequirementItem,
  type ScheduledTask,
  type ValidationFinding,
  type WbsLevel,
  type WbsReconciliation,
  type WbsWorkKind,
  type WorkPackage,
} from '@wdrg/contracts';

import {
  requirementReference,
  type ComposedContent,
  type ComposedRow,
  type DocumentComposer,
  type UpstreamContext,
  type UpstreamPlan,
  type ValidationInput,
} from './composer.types';

/**
 * Work Breakdown Structure — Document 6.
 *
 * ## A projection of the approved plan
 *
 * Phase 6 decided the hours, the order, the working days, the slack and the critical
 * path, and a person approved all of it. This composer arranges those decisions into
 * a hierarchy and changes none of them.
 *
 * That is not modesty about what could be computed here — it is the only way the
 * document can be trusted. A breakdown that re-derived its own schedule would
 * disagree with the estimate somebody signed, and nobody reading the two could tell
 * which was the plan. So every number below is copied: `effort` from the estimate
 * unit, the days from the scheduled task, `onCriticalPath` from the scheduler's own
 * flag. `validate` then proves the copy is faithful and raises a BLOCKING finding if
 * it is not, rather than quietly correcting either side.
 *
 * ## The hierarchy comes from the estimate's own grouping
 *
 * Module, submodule and feature are already on every estimate unit, put there by the
 * analysis. Inventing a different grouping here would mean the WBS and the Feature
 * Listing described the same project with different shapes.
 *
 * Levels appear only where the data justifies one: a project whose units have no
 * submodule gets no submodule tier, because a row of empty containers reads as
 * structure and is not. The two phases — implementation and project overhead — come
 * from `overheadActivity`, which Phase 6 set. Overhead is separated because "two days
 * of CI setup" is real work a client should see, and burying it inside a feature is
 * how it becomes invisible and then gets cut.
 *
 * ## One leaf per estimate unit
 *
 * The default, and it is what makes reconciliation exact: each unit's approved hours
 * land on exactly one task. A person may split a task afterwards, and
 * `allocateEffort` divides the approved figure so the parts still sum to it.
 */
@Injectable()
export class WorkBreakdownComposer implements DocumentComposer {
  readonly type = 'WORK_BREAKDOWN_STRUCTURE' as const;
  readonly shape = 'ROWS' as const;
  readonly requiredSectionKeys = [];
  readonly rowKind = 'WORK_PACKAGE' as const;

  compose(context: UpstreamContext): ComposedContent {
    const plan = context.plan;

    /*
     * No approved plan, no document. The engine's locking already refuses this, and
     * composing an hours-free skeleton would produce a breakdown that looks complete
     * and commits to nothing.
     */
    if (!plan || context.estimateUnits.length === 0) {
      return { sections: [], features: [], rows: [] };
    }

    const byUnitId = new Map(context.estimateUnits.map((unit) => [unit.id, unit]));
    const tasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
    const requirements = new Map(
      context.requirements.map((requirement) => [requirement.key, requirement]),
    );
    /*
     * An estimate unit cites requirements by their stored id; a document carries the
     * human-facing key. Skipping this translation is silent: every row would look
     * fine, and then every citation check would report an unknown requirement.
     */
    const keyById = new Map(
      context.requirements.map((requirement) => [requirement.id, requirement.key]),
    );
    /* Which approved Feature Listing rows each estimate unit was priced into. */
    const featureIdsByUnit = this.featureIndex(context, keyById);

    const rows: WorkPackage[] = [];
    /** Which WBS row each estimate unit became, for predecessor mapping. */
    const wbsIdByUnit = new Map<string, string>();

    const project: WorkPackage = this.container({
      wbsId: '1',
      level: 'PROJECT',
      sequence: 0,
      phase: '',
      label: context.projectName,
      deliverable: 'The delivered project',
    });

    rows.push(project);

    const implementation = context.estimateUnits.filter((unit) => !unit.overheadActivity);
    const overhead = context.estimateUnits.filter((unit) => unit.overheadActivity);

    let phaseSequence = 0;

    /* ------------------------------------------- phase 1: implementation */

    if (implementation.length > 0) {
      const phaseId = `1.${phaseSequence + 1}`;
      const phaseLabel = 'Implementation';

      rows.push(
        this.container({
          wbsId: phaseId,
          parentId: '1',
          level: 'PHASE',
          sequence: phaseSequence,
          phase: phaseLabel,
          label: phaseLabel,
          deliverable: 'The agreed functional scope, built and tested',
        }),
      );

      phaseSequence += 1;

      const modules = this.groupBy(implementation, (unit) => unit.module || 'General');

      let moduleSequence = 0;

      for (const [moduleName, moduleUnits] of modules) {
        const moduleId = `${phaseId}.${moduleSequence + 1}`;

        rows.push(
          this.container({
            wbsId: moduleId,
            parentId: phaseId,
            level: 'MODULE',
            sequence: moduleSequence,
            phase: phaseLabel,
            module: moduleName,
            label: moduleName,
            deliverable: `${moduleName} complete`,
          }),
        );

        moduleSequence += 1;

        /*
         * A submodule tier only where the analysis actually recorded submodules. One
         * empty container per module would add a level of depth that says nothing.
         */
        const hasSubmodules = moduleUnits.some((unit) => unit.submodule.trim().length > 0);
        const submodules = hasSubmodules
          ? this.groupBy(moduleUnits, (unit) => unit.submodule || 'General')
          : new Map([['', moduleUnits] as const]);

        let submoduleSequence = 0;

        for (const [submoduleName, submoduleUnits] of submodules) {
          const submoduleId = hasSubmodules ? `${moduleId}.${submoduleSequence + 1}` : moduleId;

          if (hasSubmodules) {
            rows.push(
              this.container({
                wbsId: submoduleId,
                parentId: moduleId,
                level: 'SUBMODULE',
                sequence: submoduleSequence,
                phase: phaseLabel,
                module: moduleName,
                submodule: submoduleName,
                label: submoduleName,
                deliverable: `${submoduleName} complete`,
              }),
            );

            submoduleSequence += 1;
          }

          const features = this.groupBy(submoduleUnits, (unit) => unit.feature);

          let featureSequence = 0;

          for (const [featureName, featureUnits] of features) {
            const featureId = `${submoduleId}.${featureSequence + 1}`;

            rows.push(
              this.container({
                wbsId: featureId,
                parentId: submoduleId,
                level: 'FEATURE',
                sequence: featureSequence,
                phase: phaseLabel,
                module: moduleName,
                submodule: submoduleName,
                feature: featureName,
                label: featureName,
                deliverable: `${featureName} working and accepted`,
              }),
            );

            featureSequence += 1;

            featureUnits.forEach((unit, index) => {
              const wbsId = `${featureId}.${index + 1}`;

              wbsIdByUnit.set(unit.id, wbsId);
              rows.push(
                this.leaf({
                  wbsId,
                  parentId: featureId,
                  sequence: index,
                  phase: phaseLabel,
                  unit,
                  task: tasks.get(unit.id),
                  plan,
                  keyById,
                  featureIds: featureIdsByUnit.get(unit.id) ?? [],
                }),
              );
            });
          }
        }
      }
    }

    /* -------------------------------------- phase 2: project overhead */

    if (overhead.length > 0) {
      const phaseId = `1.${phaseSequence + 1}`;
      const phaseLabel = 'Project overhead';

      rows.push(
        this.container({
          wbsId: phaseId,
          parentId: '1',
          level: 'PHASE',
          sequence: phaseSequence,
          phase: phaseLabel,
          label: phaseLabel,
          deliverable: 'Environments, review, stabilisation and coordination',
          workKind: 'OVERHEAD',
        }),
      );

      /*
       * Overhead is grouped by the activity Phase 6 named, and sits at the top level
       * rather than inside a feature. It is real work with real hours, and a client
       * who cannot see it will reasonably ask why the total is what it is.
       */
      const activities = this.groupBy(overhead, (unit) => OVERHEAD_LABELS[unit.overheadActivity!]);

      let activitySequence = 0;

      for (const [activityLabel, activityUnits] of activities) {
        const activityId = `${phaseId}.${activitySequence + 1}`;

        rows.push(
          this.container({
            wbsId: activityId,
            parentId: phaseId,
            level: 'FEATURE',
            sequence: activitySequence,
            phase: phaseLabel,
            feature: activityLabel,
            label: activityLabel,
            deliverable: activityLabel,
            workKind: 'OVERHEAD',
          }),
        );

        activitySequence += 1;

        activityUnits.forEach((unit, index) => {
          const wbsId = `${activityId}.${index + 1}`;

          wbsIdByUnit.set(unit.id, wbsId);
          rows.push(
            this.leaf({
              wbsId,
              parentId: activityId,
              sequence: index,
              phase: phaseLabel,
              unit,
              task: tasks.get(unit.id),
              plan,
              keyById,
              featureIds: featureIdsByUnit.get(unit.id) ?? [],
            }),
          );
        });
      }
    }

    /*
     * Predecessors, once every unit has a row. Written as WBS ids because that is
     * what a reader of this document can look up; the scheduler's unit ids mean
     * nothing on a printed sheet.
     */
    const withPredecessors = rows.map((row) => {
      if (row.level !== 'TASK' || row.estimateUnitIds.length === 0) {
        return row;
      }

      const task = tasks.get(row.estimateUnitIds[0]!);
      const predecessors = (task?.predecessorIds ?? [])
        .map((unitId) => wbsIdByUnit.get(unitId))
        .filter((id): id is string => id !== undefined);

      return {
        ...row,
        predecessors,
        ...(predecessors.length > 0 ? { dependencyType: 'FINISH_TO_START' as const } : {}),
      };
    });

    /* Containers summarise their children, so a rolled-up total is arithmetic. */
    const rolled = this.rollUp(withPredecessors, byUnitId);

    return {
      sections: [],
      features: [],
      rows: rolled.map((row, index): ComposedRow => {
        const unit = row.estimateUnitIds
          .map((id) => byUnitId.get(id))
          .find((candidate): candidate is EstimateUnit => candidate !== undefined);

        return {
          order: index,
          references: [
            ...row.requirementIds
              .map((key) => requirements.get(key))
              .filter((requirement): requirement is RequirementItem => requirement !== undefined)
              .map(requirementReference),
            ...(unit
              ? [{ kind: 'ESTIMATE_UNIT' as const, id: unit.key, label: unit.feature }]
              : []),
          ],
          payload: { ...row },
        };
      }),
    };
  }

  /* ------------------------------------------------------------ building */

  /**
   * Which approved Feature Listing rows each estimate unit belongs to.
   *
   * Nothing here is inferred. A Feature Listing row records the estimate units it was
   * priced from, so that link — approved when the listing was approved — is the mapping,
   * and one unit legitimately belonging to several rows keeps all of them.
   *
   * The requirement-key fallback exists for a listing written before that link was
   * stored: two rows sharing a requirement is also an approved relationship, just a
   * coarser one. It is used only where the direct link is absent, so it can never
   * override the better answer.
   */
  private featureIndex(
    context: UpstreamContext,
    keyById: ReadonlyMap<string, string>,
  ): ReadonlyMap<string, readonly string[]> {
    const features = context.documents.featureListing?.features ?? [];
    const index = new Map<string, string[]>();

    const add = (unitId: string, featureId: string): void => {
      const existing = index.get(unitId) ?? [];

      if (!existing.includes(featureId)) {
        index.set(unitId, [...existing, featureId]);
      }
    };

    for (const feature of features) {
      for (const unitId of feature.estimateUnitIds) {
        add(unitId, feature.featureId);
      }
    }

    /* The fallback, for units the listing did not link directly. */
    for (const unit of context.estimateUnits) {
      if (index.has(unit.id) || unit.overheadActivity) {
        continue;
      }

      const keys = new Set(
        unit.requirementIds
          .map((id) => keyById.get(id))
          .filter((key): key is string => key !== undefined),
      );

      if (keys.size === 0) {
        continue;
      }

      for (const feature of features) {
        if (feature.requirementIds.some((key) => keys.has(key))) {
          add(unit.id, feature.featureId);
        }
      }
    }

    return index;
  }

  private container(input: {
    readonly wbsId: string;
    readonly parentId?: string;
    readonly level: WbsLevel;
    readonly sequence: number;
    readonly phase: string;
    readonly module?: string;
    readonly submodule?: string;
    readonly feature?: string;
    readonly label: string;
    readonly deliverable: string;
    readonly workKind?: WbsWorkKind;
  }): WorkPackage {
    return {
      wbsId: input.wbsId,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      sequence: input.sequence,
      level: input.level,
      phase: input.phase,
      module: input.module ?? '',
      submodule: input.submodule ?? '',
      feature: input.feature ?? '',
      task: '',
      description: input.label,
      workKind: input.workKind ?? 'FEATURE',
      requirementIds: [],
      featureIds: [],
      estimateUnitIds: [],
      technologyIds: [],
      ownerRole: '',
      effort: {},
      totalEffort: 0,
      predecessors: [],
      parallelizable: false,
      onCriticalPath: false,
      deliverable: input.deliverable,
      status: 'NOT_STARTED',
      notes: '',
    };
  }

  /**
   * One task, from one estimate unit and the scheduled task for it.
   *
   * Every figure is a copy. `hours` is not recomputed from the role split, the days
   * are not recomputed from the hours, and the critical-path flag is the scheduler's.
   */
  private leaf(input: {
    readonly wbsId: string;
    readonly parentId: string;
    readonly sequence: number;
    readonly phase: string;
    readonly unit: EstimateUnit;
    readonly task: ScheduledTask | undefined;
    readonly plan: UpstreamPlan;
    /** Stored requirement id to human-facing key. */
    readonly keyById: ReadonlyMap<string, string>;
    /** Feature Listing rows this unit was priced into. */
    readonly featureIds: readonly string[];
  }): WorkPackage {
    const { unit, task, plan } = input;

    const activity = unit.overheadActivity
      ? OVERHEAD_LABELS[unit.overheadActivity]
      : TASK_CATEGORY_LABELS[unit.taskCategory];

    /*
     * Dates only when the approved plan has them. A project with no agreed start has
     * a real schedule in working days, and turning day 12 into a Tuesday would be
     * inventing the commencement the estimate deliberately left open.
     */
    const dated = !plan.relativeOnly;

    const milestone = this.milestoneFor(unit.id, plan.milestones);

    return {
      wbsId: input.wbsId,
      parentId: input.parentId,
      sequence: input.sequence,
      level: 'TASK',
      phase: input.phase,
      module: unit.module,
      submodule: unit.submodule,
      feature: unit.feature,
      task: activity,
      description: unit.rationale.slice(0, 2_000),
      workKind: unit.overheadActivity ? 'OVERHEAD' : 'FEATURE',
      requirementIds: unit.requirementIds
        .map((id) => input.keyById.get(id))
        .filter((key): key is string => key !== undefined),
      featureIds: [...input.featureIds],
      estimateUnitIds: [unit.id],
      technologyIds: [
        ...new Set(
          unit.drivers
            .map((driver) => driver.technologyId)
            .filter((id): id is string => id !== undefined),
        ),
      ],
      /* The role the scheduler contended for, which is the one that owns the task. */
      ownerRole: task?.role ?? this.dominantRole(unit.effort),
      effort: { ...unit.effort },
      totalEffort: unit.totalHours,
      ...(task
        ? {
            relativeStartDay: task.startDay,
            relativeFinishDay: task.endDay,
            workingDuration: task.durationDays,
            slackDays: task.slackDays,
            onCriticalPath: task.onCriticalPath,
            /* Slack and off the critical chain: the plan says this can float. */
            parallelizable: task.slackDays > 0 && !task.onCriticalPath,
            ...(dated && task.startDate ? { actualStartDate: task.startDate } : {}),
            ...(dated && task.endDate ? { actualFinishDate: task.endDate } : {}),
          }
        : { onCriticalPath: false, parallelizable: false }),
      predecessors: [],
      ...(milestone ? { milestoneId: milestone.id } : {}),
      deliverable: `${activity} for ${unit.feature}`,
      uncertainty: unit.uncertainty,
      status: unit.excluded ? 'EXCLUDED' : 'NOT_STARTED',
      notes: '',
    };
  }

  /** The earliest approved milestone this work has to be done for. */
  private milestoneFor(unitId: string, milestones: readonly Milestone[]): Milestone | undefined {
    return milestones
      .filter((milestone) => milestone.taskIds.includes(unitId))
      .sort((first, second) => first.day - second.day)[0];
  }

  /** The role with the most hours. Only used when a unit has no scheduled task. */
  private dominantRole(effort: Readonly<Record<string, number>>): string {
    return (
      Object.entries(effort)
        .filter(([, hours]) => hours > 0)
        .sort((first, second) => second[1] - first[1])[0]?.[0] ?? ''
    );
  }

  /**
   * Container totals, summed from the leaves beneath them.
   *
   * Arithmetic over the copied figures, so a module's hours are its tasks' hours by
   * construction. Days are the span from the earliest child start to the latest
   * finish, which is what a container occupies when its children run in parallel —
   * adding the durations would report a module as taking three times as long as the
   * approved plan says it does.
   */
  private rollUp(
    rows: readonly WorkPackage[],
    units: ReadonlyMap<string, EstimateUnit>,
  ): readonly WorkPackage[] {
    const childrenOf = new Map<string, WorkPackage[]>();

    for (const row of rows) {
      if (row.parentId !== undefined) {
        childrenOf.set(row.parentId, [...(childrenOf.get(row.parentId) ?? []), row]);
      }
    }

    const summarised = new Map<string, WorkPackage>();

    /* Deepest first, so a parent sums children that are already summed. */
    const depth = (row: WorkPackage): number => row.wbsId.split('.').length;
    const ordered = [...rows].sort((first, second) => depth(second) - depth(first));

    for (const row of ordered) {
      if (row.level === 'TASK') {
        summarised.set(row.wbsId, row);

        continue;
      }

      const children = (childrenOf.get(row.wbsId) ?? []).map(
        (child) => summarised.get(child.wbsId) ?? child,
      );

      const counted = children.filter((child) => child.status !== 'EXCLUDED');

      const effort: Record<string, number> = {};

      for (const child of counted) {
        for (const [role, hours] of Object.entries(child.effort ?? {})) {
          effort[role] = roundHours((effort[role] ?? 0) + hours);
        }
      }

      const starts = counted
        .map((child) => child.relativeStartDay)
        .filter((day): day is number => day !== undefined);
      const finishes = counted
        .map((child) => child.relativeFinishDay)
        .filter((day): day is number => day !== undefined);

      const start = starts.length > 0 ? Math.min(...starts) : undefined;
      const finish = finishes.length > 0 ? Math.max(...finishes) : undefined;

      const dates = counted
        .map((child) => child.actualStartDate)
        .filter((date): date is string => date !== undefined)
        .sort();
      const finishDates = counted
        .map((child) => child.actualFinishDate)
        .filter((date): date is string => date !== undefined)
        .sort();

      summarised.set(row.wbsId, {
        ...row,
        requirementIds: [...new Set(counted.flatMap((child) => child.requirementIds))],
        estimateUnitIds: [...new Set(counted.flatMap((child) => child.estimateUnitIds))],
        technologyIds: [...new Set(counted.flatMap((child) => child.technologyIds))],
        effort,
        totalEffort: roundHours(Object.values(effort).reduce((sum, hours) => sum + hours, 0)),
        ...(start !== undefined ? { relativeStartDay: start } : {}),
        ...(finish !== undefined ? { relativeFinishDay: finish } : {}),
        ...(start !== undefined && finish !== undefined
          ? { workingDuration: finish - start + 1 }
          : {}),
        ...(dates[0] !== undefined ? { actualStartDate: dates[0] } : {}),
        ...(finishDates.at(-1) !== undefined ? { actualFinishDate: finishDates.at(-1)! } : {}),
        /* A container is on the critical path when any of its work is. */
        onCriticalPath: counted.some((child) => child.onCriticalPath),
        /* Every child could float, so the container can. */
        parallelizable: counted.length > 0 && counted.every((child) => child.parallelizable),
        status: this.containerStatus(counted, children, units),
      });
    }

    return rows.map((row) => summarised.get(row.wbsId) ?? row);
  }

  /** A container with nothing left in it is excluded; otherwise it is live. */
  private containerStatus(
    counted: readonly WorkPackage[],
    children: readonly WorkPackage[],
    _units: ReadonlyMap<string, EstimateUnit>,
  ): WorkPackage['status'] {
    return children.length > 0 && counted.length === 0 ? 'EXCLUDED' : 'NOT_STARTED';
  }

  private groupBy<T>(
    items: readonly T[],
    key: (item: T) => string,
  ): ReadonlyMap<string, readonly T[]> {
    const groups = new Map<string, T[]>();

    for (const item of items) {
      const group = key(item);

      groups.set(group, [...(groups.get(group) ?? []), item]);
    }

    return groups;
  }

  /* --------------------------------------------------------- validation */

  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const packages = input.rows.map((row) => row.payload as WorkPackage);
    const leaves = packages.filter((row) => row.level === 'TASK');
    const plan = input.context.plan;

    if (!plan) {
      return [
        {
          kind: 'estimate_missing',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: 'There is no approved estimate for this breakdown to be based on.',
          action: 'Approve the estimate, then regenerate this document.',
          subjectIds: [],
        },
      ];
    }

    /*
     * 1. The hours. First and BLOCKING, because a breakdown that does not add up to
     * the approved estimate is the one failure that makes the whole document
     * misleading — it will be planned against, and then found to be wrong.
     */
    const reconciliation = reconcileWbsEffort({
      approvedByRole: plan.effortByRole,
      approvedUnitIds: input.context.estimateUnits
        .filter((unit) => !unit.excluded)
        .map((unit) => unit.id),
      leaves: leaves.map((leaf) => ({
        effort: leaf.effort,
        estimateUnitIds: leaf.estimateUnitIds,
        status: leaf.status,
      })),
    });

    findings.push(
      reconciliation.reconciles
        ? {
            kind: 'effort_mismatch',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: 'Every hour in this breakdown matches the approved estimate, role by role.',
            action: `${reconciliation.wbsTotal} hours across ${leaves.length} tasks.`,
            subjectIds: [],
          }
        : {
            kind: 'effort_mismatch',
            severity: 'BLOCKING',
            detectedBy: 'DETERMINISTIC',
            summary: this.mismatchSummary(reconciliation),
            action:
              'The breakdown must total exactly what was approved. Regenerate it, or change the estimate and approve that instead.',
            subjectIds: [
              ...reconciliation.mismatchedRoles.map((entry) => entry.role),
              ...reconciliation.unmappedEstimateUnitIds,
              ...reconciliation.unknownEstimateUnitIds,
            ],
          },
    );

    /* 2. The shape of the tree and its ordering. */
    const problems = validateWbsStructure(packages);

    if (problems.length > 0) {
      findings.push({
        kind: 'structure_invalid',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${problems.length} row breaks the structure of the breakdown.`,
        action: problems
          .slice(0, 8)
          .map((problem) => `${problem.wbsId}: ${problem.detail}`)
          .join(' '),
        subjectIds: [...new Set(problems.map((problem) => problem.wbsId))],
      });
    }

    /*
     * 3. The critical path. A task claiming to be critical when the approved plan
     * says it has slack changes which work a reader protects, so it blocks.
     */
    const planCritical = new Set(plan.criticalPath);
    const disagreeing = leaves.filter((leaf) => {
      const unitId = leaf.estimateUnitIds[0];

      return (
        unitId !== undefined &&
        leaf.status !== 'EXCLUDED' &&
        planCritical.has(unitId) !== leaf.onCriticalPath
      );
    });

    if (disagreeing.length > 0) {
      findings.push({
        kind: 'critical_path_mismatch',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${disagreeing.length} task disagrees with the approved plan about being on the critical path.`,
        action:
          'The critical path is calculated during estimation and copied here. Regenerate this document.',
        subjectIds: disagreeing.map((leaf) => leaf.wbsId),
      });
    }

    /* 4. Work scheduled past the end of the approved plan. */
    const overrunning = leaves.filter(
      (leaf) =>
        leaf.status !== 'EXCLUDED' &&
        leaf.relativeFinishDay !== undefined &&
        plan.totalWorkingDays > 0 &&
        leaf.relativeFinishDay > plan.totalWorkingDays,
    );

    if (overrunning.length > 0) {
      findings.push({
        kind: 'schedule_beyond_plan',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${overrunning.length} task finishes after the approved plan ends on working day ${plan.totalWorkingDays}.`,
        action: 'Either the schedule or this breakdown is wrong. They cannot both be approved.',
        subjectIds: overrunning.map((leaf) => leaf.wbsId),
      });
    }

    /*
     * 5. Dates on a plan that has none. Publishing a calendar date for a project with
     * no agreed start invents the commencement, and a client reads a date as a promise.
     */
    if (plan.relativeOnly) {
      const dated = packages.filter(
        (row) => row.actualStartDate !== undefined || row.actualFinishDate !== undefined,
      );

      if (dated.length > 0) {
        findings.push({
          kind: 'invented_date',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `${dated.length} row carries a calendar date, and this project has no agreed start date.`,
          action:
            'The plan is in working days. Remove the dates, or agree a start date during estimation.',
          subjectIds: dated.map((row) => row.wbsId),
        });
      }
    }

    /* 6. Citations that name something not in the approved baseline. */
    const approved = new Set(input.context.requirements.map((requirement) => requirement.key));
    const unknown = [
      ...new Set(packages.flatMap((row) => row.requirementIds.filter((key) => !approved.has(key)))),
    ];

    if (unknown.length > 0) {
      findings.push({
        kind: 'unknown_requirement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknown.length} task cites a requirement that is not in the approved baseline.`,
        action: unknown.join(', '),
        subjectIds: unknown,
      });
    }

    const rejected = input.context.allRequirements.filter(
      (requirement) =>
        requirement.status === 'rejected' &&
        leaves.some(
          (leaf) => leaf.status !== 'EXCLUDED' && leaf.requirementIds.includes(requirement.key),
        ),
    );

    if (rejected.length > 0) {
      findings.push({
        kind: 'rejected_requirement_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${rejected.length} task is for a requirement that was rejected.`,
        action: rejected.map((requirement) => requirement.key).join(', '),
        subjectIds: rejected.map((requirement) => requirement.key),
      });
    }

    /*
     * 6b. Feature Listing citations. A task naming a feature the current listing does
     * not contain is pointing at scope that was renamed or removed, which makes the
     * traceability chain wrong in the direction nobody checks by eye.
     */
    const approvedFeatures = new Set(
      (input.context.documents.featureListing?.features ?? []).map((feature) => feature.featureId),
    );
    const unknownFeatures = [
      ...new Set(
        packages.flatMap((row) => row.featureIds.filter((id) => !approvedFeatures.has(id))),
      ),
    ];

    if (unknownFeatures.length > 0) {
      findings.push({
        kind: 'unknown_feature_reference',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknownFeatures.length} task cites a feature that is not in the current Feature Listing.`,
        action:
          'Work can only be traced to scope somebody agreed to. Regenerate this breakdown against the current listing.',
        subjectIds: unknownFeatures,
      });
    }

    /* 7. Work for scope somebody deliberately left out. */
    const excludedScope = new Set(input.excludedRequirementIds);
    const forExcluded = leaves.filter(
      (leaf) =>
        leaf.status !== 'EXCLUDED' && leaf.requirementIds.some((key) => excludedScope.has(key)),
    );

    if (forExcluded.length > 0) {
      findings.push({
        kind: 'work_for_excluded_scope',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${forExcluded.length} task is for scope that was deliberately left out.`,
        action: 'Either the exclusion is wrong or the task is. Both cannot be in one document.',
        subjectIds: forExcluded.map((leaf) => leaf.wbsId),
      });
    }

    /* 8. Coverage of the scope the estimate priced. */
    const coverage = this.coverageFor(input);

    findings.push(
      coverage.complete
        ? {
            kind: 'requirement_uncovered',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: 'Every priced requirement and every estimate unit has work against it.',
            action: `${coverage.mappedRequirements} of ${coverage.applicableRequirements} requirements, ${coverage.mappedEstimateUnits} of ${coverage.applicableEstimateUnits} estimate units.`,
            subjectIds: [],
          }
        : {
            kind: 'requirement_uncovered',
            severity: 'BLOCKING',
            detectedBy: 'DETERMINISTIC',
            summary: `${coverage.unmappedRequirementIds.length} priced requirement has no work package.`,
            action:
              'Every requirement the estimate priced must appear as work, or the plan is missing part of what was agreed.',
            subjectIds: [...coverage.unmappedRequirementIds, ...coverage.unsupportedWbsIds],
          },
    );

    /* 9. Rows a person added with nothing recorded about where they came from. */
    const unattributed = input.rows
      .filter(
        (row) =>
          row.origin === 'USER_DEFINED' &&
          row.references.length === 0 &&
          (row.attribution ?? '').trim().length === 0,
      )
      .map((row) => (row.payload as WorkPackage).wbsId);

    if (unattributed.length > 0) {
      findings.push({
        kind: 'attribution_missing',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unattributed.length} task was added by hand with nothing recorded about where it came from.`,
        action: 'Say what each one rests on — work nobody can trace cannot be planned against.',
        subjectIds: unattributed,
      });
    }

    /* 10. The upstream authority this document quotes. */
    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'The approved requirements have changed since this breakdown was written.',
        action: 'Regenerate against the current baseline.',
        subjectIds: [],
      });
    }

    return findings;
  }

  private mismatchSummary(reconciliation: {
    readonly mismatchedRoles: readonly { role: string; approved: number; inWbs: number }[];
    readonly unmappedEstimateUnitIds: readonly string[];
    readonly unknownEstimateUnitIds: readonly string[];
    readonly approvedTotal: number;
    readonly wbsTotal: number;
  }): string {
    const parts: string[] = [];

    if (reconciliation.approvedTotal !== reconciliation.wbsTotal) {
      parts.push(
        `This breakdown totals ${reconciliation.wbsTotal} hours against an approved ${reconciliation.approvedTotal}.`,
      );
    }

    for (const entry of reconciliation.mismatchedRoles.slice(0, 6)) {
      parts.push(`${entry.role}: ${entry.inWbs} here against ${entry.approved} approved.`);
    }

    if (reconciliation.unmappedEstimateUnitIds.length > 0) {
      parts.push(
        `${reconciliation.unmappedEstimateUnitIds.length} priced item has no task against it.`,
      );
    }

    if (reconciliation.unknownEstimateUnitIds.length > 0) {
      parts.push(
        `${reconciliation.unknownEstimateUnitIds.length} task cites an estimate item that is not in the approved plan.`,
      );
    }

    return parts.join(' ');
  }

  /**
   * The reconciliation, for the reader as well as the checker.
   *
   * Shown on screen rather than only raised as a finding, because "these 340 hours are
   * the 340 hours you approved" is the single fact that makes the document worth
   * trusting, and it is worth saying when it is true.
   */
  reconciliationFor(input: ValidationInput): WbsReconciliation | null {
    const plan = input.context.plan;

    if (!plan) {
      return null;
    }

    const leaves = input.rows
      .map((row) => row.payload as WorkPackage)
      .filter((row) => row.level === 'TASK');

    return reconcileWbsEffort({
      approvedByRole: plan.effortByRole,
      approvedUnitIds: input.context.estimateUnits
        .filter((unit) => !unit.excluded)
        .map((unit) => unit.id),
      leaves: leaves.map((leaf) => ({
        effort: leaf.effort,
        estimateUnitIds: leaf.estimateUnitIds,
        status: leaf.status,
      })),
    });
  }

  /** Coverage over the scope the approved estimate actually priced. */
  coverageFor(input: ValidationInput) {
    const packages = input.rows.map((row) => row.payload as WorkPackage);

    return calculateWbsCoverage({
      applicableRequirementIds: this.applicableRequirementIds(input.context),
      /*
       * The approved Feature Listing, so feature coverage is a real measurement. An
       * agreed feature with no work package against it drops this below complete.
       */
      applicableFeatureIds: (input.context.documents.featureListing?.features ?? []).map(
        (feature) => feature.featureId,
      ),
      applicableEstimateUnitIds: input.context.estimateUnits
        .filter((unit) => !unit.excluded)
        .map((unit) => unit.id),
      leaves: packages
        .filter((row) => row.level === 'TASK')
        .map((row) => ({
          wbsId: row.wbsId,
          requirementIds: row.requirementIds,
          featureIds: row.featureIds,
          estimateUnitIds: row.estimateUnitIds,
          status: row.status,
          workKind: row.workKind,
          totalEffort: row.totalEffort,
        })),
    });
  }

  /**
   * Requirements this document answers for: the ones the estimate priced.
   *
   * Not every approved requirement. A constraint like "the system must comply with
   * the retention policy" is real and approved and has no work package of its own —
   * it shapes other work. The estimate is where scope becomes work, so what it
   * priced is what a breakdown owes an answer for; anything it left unpriced is
   * Phase 6's coverage question, not this document's.
   */
  applicableRequirementIds(context: UpstreamContext): readonly string[] {
    /* An estimate unit cites the stored id, so the comparison is against `id`. */
    const priced = new Set(
      context.estimateUnits.filter((unit) => !unit.excluded).flatMap((unit) => unit.requirementIds),
    );

    return context.requirements
      .filter((requirement) => priced.has(requirement.id))
      .map((requirement) => requirement.key);
  }
}
