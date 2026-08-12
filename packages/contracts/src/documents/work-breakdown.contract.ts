import { z } from 'zod';

import { dependencyTypeSchema } from '../estimation/dependency.contract';
import { roleEffortSchema } from '../estimation/role.contract';

/**
 * Work Breakdown Structure — Document 6.
 *
 * ## It is a projection, not a plan of its own
 *
 * Phase 6 already answered every quantitative question: how many hours per role, in
 * what order, on which working day, with what slack, and which chain is critical.
 * This document arranges those answers into a hierarchy somebody can read and hand
 * to a delivery team.
 *
 * That distinction decides the whole design. A second planner here would produce a
 * second set of numbers, and two plans that disagree are worse than one plan nobody
 * likes. So the effort is copied, the schedule is copied, the critical path is
 * copied, and `reconcileWbsEffort` proves the copy is exact — per role and in total.
 * A discrepancy is BLOCKING, because a work breakdown whose hours differ from the
 * approved estimate is a document that will be planned against and then found wrong.
 *
 * ## Decomposition preserves the total
 *
 * One estimate unit may become several tasks — validation, business logic,
 * persistence — and that is genuinely useful. `allocateEffort` splits the approved
 * hours across those tasks so the parts sum to exactly what was approved, using
 * largest-remainder in hundredths of an hour so nothing is lost or invented. Ten
 * backend hours across three tasks become 3.34, 3.33 and 3.33; they never become
 * three threes, and an estimate's own 4.48 does not quietly become 4.
 *
 * ## What a model may contribute
 *
 * Wording, grouping and decomposition proposals. Nothing numeric, nothing about
 * dates, and nothing about the critical path — those come from the approved plan or
 * from arithmetic over it. The generation schema has no field for an hours figure,
 * a date or a critical-path flag, so this is a shape a model cannot express rather
 * than a rule it is asked to respect.
 */

/* ------------------------------------------------------------- hierarchy */

/**
 * Where a row sits.
 *
 * Five levels, and a project need not use all of them: a row appears only where the
 * source justifies one. A submodule level for a project whose estimate has no
 * submodules would be a tier of empty containers, which reads as structure and is
 * not.
 */
export const WBS_LEVELS = ['PROJECT', 'PHASE', 'MODULE', 'SUBMODULE', 'FEATURE', 'TASK'] as const;

export type WbsLevel = (typeof WBS_LEVELS)[number];
export const wbsLevelSchema = z.enum(WBS_LEVELS);

export const WBS_LEVEL_LABELS: Readonly<Record<WbsLevel, string>> = {
  PROJECT: 'Project',
  PHASE: 'Phase',
  MODULE: 'Module',
  SUBMODULE: 'Sub module',
  FEATURE: 'Feature',
  TASK: 'Task',
};

/** Only a task carries effort. Everything above it is a sum of its children. */
export function isLeafLevel(level: WbsLevel): boolean {
  return level === 'TASK';
}

/**
 * Whether this work delivers an agreed feature or supports the delivery of all of them.
 *
 * The distinction exists to keep feature coverage honest. Environment setup, CI, code
 * review and release stabilisation are real work with real hours and no Feature Listing
 * row — because a client never agreed to "CI setup" as a feature. Counting them as
 * unmapped feature work would report a breakdown as incompletely traced for doing
 * exactly the right thing; counting them as mapped would invent a feature they support.
 *
 * So they are classified, explicitly, and excluded from the feature-coverage judgement
 * while remaining fully present in the effort reconciliation.
 */
export const WBS_WORK_KINDS = ['FEATURE', 'OVERHEAD'] as const;

export type WbsWorkKind = (typeof WBS_WORK_KINDS)[number];

export const WBS_WORK_KIND_LABELS: Readonly<Record<WbsWorkKind, string>> = {
  FEATURE: 'Feature work',
  OVERHEAD: 'Delivery overhead',
};

/* --------------------------------------------------------------- status */

export const WBS_TASK_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETE',
  'EXCLUDED',
] as const;

export type WbsTaskStatus = (typeof WBS_TASK_STATUSES)[number];

export const WBS_TASK_STATUS_LABELS: Readonly<Record<WbsTaskStatus, string>> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  COMPLETE: 'Complete',
  EXCLUDED: 'Deliberately excluded',
};

/* ------------------------------------------------------------ the row */

export const workPackageSchema = z
  .object({
    /** Human-facing outline number: `1`, `1.2`, `1.2.3`. Assigned by the engine. */
    wbsId: z.string().regex(/^\d+(\.\d+)*$/, 'A WBS id is an outline number like 1.2.3'),
    /** The row above this one. Absent for the project row. */
    parentId: z.string().max(64).optional(),
    /** Position among its siblings. */
    sequence: z.number().int().nonnegative(),
    level: wbsLevelSchema,

    /* What this row is. */
    /** Delivery phase or group, from the approved milestone structure. */
    phase: z.string().max(200),
    module: z.string().max(200),
    submodule: z.string().max(200),
    feature: z.string().max(300),
    /** The work itself. Only a task has one. */
    task: z.string().max(300),
    description: z.string().max(2_000),

    /**
     * Whether this delivers an agreed feature or supports delivery generally.
     *
     * Feature work must trace to at least one Feature Listing row; overhead must not
     * pretend to. See `WBS_WORK_KINDS`.
     */
    workKind: z.enum(WBS_WORK_KINDS),

    /* Traceability. Every leaf has at least one estimate unit. */
    requirementIds: z.array(z.string().max(64)).max(60),
    /**
     * Feature Listing rows this work delivers.
     *
     * Derived from the approved chain rather than guessed: a Feature Listing row already
     * records the estimate units it was priced from, so a task built from unit E-004
     * belongs to whichever rows cite E-004. Where the listing predates that link, the
     * shared requirement keys are the fallback — also an approved relationship.
     *
     * Empty for overhead work, and empty is then the correct answer.
     */
    featureIds: z.array(z.string().max(64)).max(60),
    estimateUnitIds: z.array(z.string().max(64)).max(60),
    technologyIds: z.array(z.string().max(64)).max(40),

    /* Effort, copied from the approved estimate and never computed here. */
    /** The role that owns the task. Blank on a container row. */
    ownerRole: z.string().max(60),
    /**
     * Hours per role.
     *
     * Every standard role has a key in `roleEffortSchema`, so backend, frontend,
     * mobile, QA, design, DevOps, BA, PM, architecture, AI/ML and data all have a
     * place, with custom roles carried alongside. A role with no work is zero
     * rather than absent, because a blank column and a zero column read differently
     * in a sheet somebody plans against.
     */
    effort: roleEffortSchema,
    totalEffort: z.number().min(0),
    /** People assumed on this task, where the approved capacity establishes one. */
    resourceCount: z.number().min(0).optional(),

    /* Schedule, copied from the approved plan. */
    /** 1-based working day from project start. Always available. */
    relativeStartDay: z.number().int().min(1).optional(),
    relativeFinishDay: z.number().int().min(1).optional(),
    /** Calendar dates, only when the project has a confirmed start date. */
    actualStartDate: z.string().max(10).optional(),
    actualFinishDate: z.string().max(10).optional(),
    /** Working days occupied. */
    workingDuration: z.number().int().min(0).optional(),
    /** Elapsed days including non-working ones, when dates are known. */
    calendarDuration: z.number().int().min(0).optional(),

    /* Order and shape of the work. */
    /** WBS ids that must come first. */
    predecessors: z.array(z.string().max(64)).max(50),
    dependencyType: dependencyTypeSchema.optional(),
    /**
     * Whether this can run alongside its siblings.
     *
     * True when the approved schedule gave it slack and it is not on the critical
     * path — which is a fact about the plan rather than an aspiration.
     */
    parallelizable: z.boolean(),
    /** Working days it could slip without moving the finish. */
    slackDays: z.number().int().min(0).optional(),
    onCriticalPath: z.boolean(),

    /* What it produces. */
    /** Approved milestone this contributes to. */
    milestoneId: z.string().max(64).optional(),
    deliverable: z.string().max(300),
    /*
     * Client dependencies are deliberately *not* stored here.
     *
     * The Client Dependency Sheet is generated after this document and owns the link,
     * in its own `wbsIds`. Storing the reverse direction on a work package would mean
     * generating document 7 had to rewrite document 6 — including an issued one — so
     * the reverse view is derived on read instead. See `reverseDependencyIndex`.
     */
    /** The estimate's own uncertainty for this work, quoted not judged. */
    uncertainty: z.string().max(20).optional(),

    status: z.enum(WBS_TASK_STATUSES),
    /** Only meaningful once somebody is tracking delivery. */
    percentComplete: z.number().min(0).max(100).optional(),
    notes: z.string().max(1_000),
  })
  .strict();

export type WorkPackage = z.infer<typeof workPackageSchema>;

/* ------------------------------------------------------ effort allocation */

/**
 * Split hours across children so the parts sum to exactly the whole.
 *
 * Largest remainder, in hundredths of an hour. The obvious approach — divide and round
 * each part — loses or invents a fraction per child, and a work breakdown that does not
 * add up to its own estimate is the one thing this document must never be.
 *
 * Weights let a caller say "validation is smaller than business logic". Equal
 * weights give an even split with the remainder going to the earliest children,
 * which is arbitrary but deterministic, and deterministic is what matters: the same
 * inputs must always produce the same sheet.
 */
export function allocateEffort(total: number, weights: readonly number[]): readonly number[] {
  if (weights.length === 0) {
    return [];
  }

  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);

  if (total <= 0 || weightTotal <= 0) {
    return weights.map(() => 0);
  }

  /*
   * Worked in hundredths of an hour, not whole hours.
   *
   * Phase 6 produces fractional figures — 4.48 backend hours is an ordinary estimate
   * line — so a whole-hour split would silently drop the fraction, and a breakdown
   * that loses 0.48 of an hour per task does not reconcile with the plan it came
   * from. Hundredths is the precision the estimate itself is meaningful to.
   */
  const units = Math.round(total * 100);
  const exact = weights.map((weight) => (Math.max(0, weight) / weightTotal) * units);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = units - floors.reduce((sum, value) => sum + value, 0);

  /* Whoever lost the most to flooring gets the spare hundredths first. */
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((first, second) => second.fraction - first.fraction || first.index - second.index);

  const allocated = [...floors];

  for (const { index } of order) {
    if (remainder <= 0) {
      break;
    }

    allocated[index] = (allocated[index] ?? 0) + 1;
    remainder -= 1;
  }

  return allocated.map((value) => value / 100);
}

/**
 * Hours, at the precision the estimate is meaningful to.
 *
 * Summing floats produces 70.46000000000001, which fails an equality check against
 * the figure it is supposed to equal and — worse — appears on screen. Every total this
 * document computes goes through here.
 */
export function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Split a whole role-effort record across children, preserving every total. */
export function allocateRoleEffort(
  effort: Readonly<Record<string, number>>,
  weights: readonly number[],
): readonly Record<string, number>[] {
  const parts: Record<string, number>[] = weights.map(() => ({}));

  for (const [role, hours] of Object.entries(effort)) {
    const split = allocateEffort(hours, weights);

    split.forEach((value, index) => {
      if (value > 0) {
        parts[index]![role] = value;
      }
    });
  }

  return parts;
}

/* ---------------------------------------------------------- reconciliation */

export const wbsReconciliationSchema = z
  .object({
    /** Hours the approved estimate holds, per role. */
    approvedByRole: z.record(z.string().max(60), z.number()),
    /** Hours this document's leaf tasks hold, per role. */
    wbsByRole: z.record(z.string().max(60), z.number()),
    approvedTotal: z.number(),
    wbsTotal: z.number(),
    /** Roles where the two disagree, with the size of the disagreement. */
    mismatchedRoles: z.array(
      z.object({ role: z.string().max(60), approved: z.number(), inWbs: z.number() }).strict(),
    ),
    /** Estimate units the approved plan holds that no task covers. */
    unmappedEstimateUnitIds: z.array(z.string().max(64)).max(500),
    /** Tasks citing an estimate unit that is not in the approved plan. */
    unknownEstimateUnitIds: z.array(z.string().max(64)).max(500),
    reconciles: z.boolean(),
  })
  .strict();

export type WbsReconciliation = z.infer<typeof wbsReconciliationSchema>;

/**
 * Whether the breakdown adds up to the estimate it came from.
 *
 * Compared per role as well as in total, because two roles can offset each other
 * and leave a total that looks right — which would be the most misleading possible
 * result. Rounded to the hour, since the allocation works in whole hours.
 */
export function reconcileWbsEffort(input: {
  readonly approvedByRole: Readonly<Record<string, number>>;
  readonly approvedUnitIds: readonly string[];
  readonly leaves: readonly Pick<WorkPackage, 'effort' | 'estimateUnitIds' | 'status'>[];
}): WbsReconciliation {
  const counted = input.leaves.filter((leaf) => leaf.status !== 'EXCLUDED');

  const wbsByRole: Record<string, number> = {};

  for (const leaf of counted) {
    /* A task with no hours recorded is legitimate; it must not be a crash. */
    for (const [role, hours] of Object.entries(leaf.effort ?? {})) {
      wbsByRole[role] = roundHours((wbsByRole[role] ?? 0) + hours);
    }
  }

  const roles = [...new Set([...Object.keys(input.approvedByRole), ...Object.keys(wbsByRole)])];

  const mismatchedRoles = roles
    .map((role) => ({
      role,
      approved: roundHours(input.approvedByRole[role] ?? 0),
      inWbs: roundHours(wbsByRole[role] ?? 0),
    }))
    .filter((entry) => entry.approved !== entry.inWbs);

  const cited = new Set(counted.flatMap((leaf) => leaf.estimateUnitIds));
  const approved = new Set(input.approvedUnitIds);

  const unmappedEstimateUnitIds = input.approvedUnitIds.filter((id) => !cited.has(id));
  const unknownEstimateUnitIds = [...cited].filter((id) => !approved.has(id));

  const approvedTotal = roundHours(
    Object.values(input.approvedByRole).reduce((sum, hours) => sum + hours, 0),
  );
  const wbsTotal = roundHours(Object.values(wbsByRole).reduce((sum, hours) => sum + hours, 0));

  return {
    approvedByRole: input.approvedByRole,
    wbsByRole,
    approvedTotal,
    wbsTotal,
    mismatchedRoles,
    unmappedEstimateUnitIds,
    unknownEstimateUnitIds,
    reconciles:
      mismatchedRoles.length === 0 &&
      approvedTotal === wbsTotal &&
      unmappedEstimateUnitIds.length === 0 &&
      unknownEstimateUnitIds.length === 0,
  };
}

/* -------------------------------------------------------------- coverage */

export const wbsCoverageSchema = z
  .object({
    applicableRequirements: z.number().int().nonnegative(),
    mappedRequirements: z.number().int().nonnegative(),
    unmappedRequirementIds: z.array(z.string().max(64)).max(500),
    /** Approved Feature Listing rows this breakdown is answerable for. */
    applicableFeatures: z.number().int().nonnegative(),
    mappedFeatures: z.number().int().nonnegative(),
    /** Approved features with no work package against them. */
    unmappedFeatureIds: z.array(z.string().max(64)).max(500),
    applicableEstimateUnits: z.number().int().nonnegative(),
    mappedEstimateUnits: z.number().int().nonnegative(),
    /** Tasks that trace to nothing at all. */
    unsupportedWbsIds: z.array(z.string().max(64)).max(500),
    /**
     * Work deliberately classified as delivery overhead.
     *
     * Reported rather than hidden: a reader should be able to see that eleven tasks
     * carry no feature because they support all of them, not wonder why the feature
     * count is lower than the task count.
     */
    overheadWbsIds: z.array(z.string().max(64)).max(500),
    overheadHours: z.number().min(0),
    /** Feature work that cites a feature the current listing does not contain. */
    unknownFeatureIds: z.array(z.string().max(64)).max(500),
    /** Feature work carrying no feature at all, which overhead may legitimately do. */
    untracedFeatureWorkIds: z.array(z.string().max(64)).max(500),
    complete: z.boolean(),
  })
  .strict();

export type WbsCoverage = z.infer<typeof wbsCoverageSchema>;

/**
 * What this breakdown covers, and what it deliberately does not.
 *
 * Feature coverage is a real measurement here, not a formality: it is calculated from
 * the feature ids the work packages actually carry, so an approved feature with no work
 * against it drops the figure below complete. Overhead is excluded from that judgement
 * by classification rather than by being quietly ignored — see `WBS_WORK_KINDS`.
 */
export function calculateWbsCoverage(input: {
  readonly applicableRequirementIds: readonly string[];
  readonly applicableFeatureIds: readonly string[];
  readonly applicableEstimateUnitIds: readonly string[];
  readonly leaves: readonly Pick<
    WorkPackage,
    | 'wbsId'
    | 'requirementIds'
    | 'featureIds'
    | 'estimateUnitIds'
    | 'status'
    | 'workKind'
    | 'totalEffort'
  >[];
}): WbsCoverage {
  const counted = input.leaves.filter((leaf) => leaf.status !== 'EXCLUDED');
  const featureWork = counted.filter((leaf) => leaf.workKind === 'FEATURE');
  const overhead = counted.filter((leaf) => leaf.workKind === 'OVERHEAD');

  const requirements = new Set(counted.flatMap((leaf) => leaf.requirementIds));
  const features = new Set(counted.flatMap((leaf) => leaf.featureIds));
  const units = new Set(counted.flatMap((leaf) => leaf.estimateUnitIds));

  const unmappedRequirementIds = input.applicableRequirementIds.filter(
    (id) => !requirements.has(id),
  );
  const unmappedFeatureIds = input.applicableFeatureIds.filter((id) => !features.has(id));

  const approvedFeatures = new Set(input.applicableFeatureIds);
  const unknownFeatureIds = [
    ...new Set(
      counted.flatMap((leaf) => leaf.featureIds.filter((id) => !approvedFeatures.has(id))),
    ),
  ];

  /*
   * Feature work with no feature. Overhead is excluded by construction: it is
   * *supposed* to carry none, and flagging it would penalise the correct answer.
   */
  const untracedFeatureWorkIds = featureWork
    .filter((leaf) => leaf.featureIds.length === 0)
    .map((leaf) => leaf.wbsId);

  const unsupportedWbsIds = counted
    .filter(
      (leaf) =>
        leaf.estimateUnitIds.length === 0 &&
        leaf.requirementIds.length === 0 &&
        leaf.featureIds.length === 0,
    )
    .map((leaf) => leaf.wbsId);

  return {
    applicableRequirements: input.applicableRequirementIds.length,
    mappedRequirements: input.applicableRequirementIds.filter((id) => requirements.has(id)).length,
    unmappedRequirementIds,
    applicableFeatures: input.applicableFeatureIds.length,
    mappedFeatures: input.applicableFeatureIds.filter((id) => features.has(id)).length,
    unmappedFeatureIds,
    applicableEstimateUnits: input.applicableEstimateUnitIds.length,
    mappedEstimateUnits: input.applicableEstimateUnitIds.filter((id) => units.has(id)).length,
    unsupportedWbsIds,
    overheadWbsIds: overhead.map((leaf) => leaf.wbsId),
    overheadHours: roundHours(overhead.reduce((sum, leaf) => sum + leaf.totalEffort, 0)),
    unknownFeatureIds,
    untracedFeatureWorkIds,
    complete:
      unmappedRequirementIds.length === 0 &&
      unmappedFeatureIds.length === 0 &&
      unknownFeatureIds.length === 0 &&
      untracedFeatureWorkIds.length === 0 &&
      unsupportedWbsIds.length === 0 &&
      input.applicableEstimateUnitIds.every((id) => units.has(id)),
  };
}

/* ------------------------------------------------------ structural checks */

export interface WbsStructureProblem {
  readonly kind:
    | 'unknown_parent'
    | 'self_parent'
    | 'cycle'
    | 'unknown_predecessor'
    | 'self_predecessor'
    | 'excluded_predecessor'
    | 'leaf_with_children'
    | 'duplicate_row';
  readonly wbsId: string;
  readonly detail: string;
}

/**
 * Everything wrong with the shape of the tree and its ordering.
 *
 * A hierarchy that points at itself, a predecessor that does not exist, a task with
 * children hanging off it — each makes the sheet unusable in a different way, and
 * each is cheap to detect and impossible to spot by eye in three hundred rows.
 */
export function validateWbsStructure(
  rows: readonly Pick<
    WorkPackage,
    'wbsId' | 'parentId' | 'level' | 'predecessors' | 'status' | 'task' | 'feature'
  >[],
): readonly WbsStructureProblem[] {
  const problems: WbsStructureProblem[] = [];
  const byId = new Map(rows.map((row) => [row.wbsId, row]));
  const excluded = new Set(rows.filter((row) => row.status === 'EXCLUDED').map((row) => row.wbsId));

  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.wbsId)) {
      problems.push({
        kind: 'duplicate_row',
        wbsId: row.wbsId,
        detail: 'Two rows share this outline number.',
      });
    }

    seen.add(row.wbsId);

    if (row.parentId !== undefined) {
      if (row.parentId === row.wbsId) {
        problems.push({
          kind: 'self_parent',
          wbsId: row.wbsId,
          detail: 'A row is its own parent.',
        });
      } else if (!byId.has(row.parentId)) {
        problems.push({
          kind: 'unknown_parent',
          wbsId: row.wbsId,
          detail: `Parent ${row.parentId} is not in this document.`,
        });
      } else if (byId.get(row.parentId)!.level === 'TASK') {
        problems.push({
          kind: 'leaf_with_children',
          wbsId: row.wbsId,
          detail: `Parent ${row.parentId} is a task, which cannot contain other work.`,
        });
      }
    }

    for (const predecessor of row.predecessors) {
      if (predecessor === row.wbsId) {
        problems.push({
          kind: 'self_predecessor',
          wbsId: row.wbsId,
          detail: 'A row cannot wait for itself.',
        });
      } else if (!byId.has(predecessor)) {
        problems.push({
          kind: 'unknown_predecessor',
          wbsId: row.wbsId,
          detail: `Predecessor ${predecessor} is not in this document.`,
        });
      } else if (excluded.has(predecessor)) {
        problems.push({
          kind: 'excluded_predecessor',
          wbsId: row.wbsId,
          detail: `Predecessor ${predecessor} is excluded, so it will never finish.`,
        });
      }
    }
  }

  problems.push(...cycles(rows));

  return problems;
}

/** Cycles in the parent chain and in the predecessor graph. */
function cycles(
  rows: readonly Pick<WorkPackage, 'wbsId' | 'parentId' | 'predecessors'>[],
): readonly WbsStructureProblem[] {
  const problems: WbsStructureProblem[] = [];
  const byId = new Map(rows.map((row) => [row.wbsId, row]));

  for (const row of rows) {
    /* Parent chain. */
    const walked = new Set<string>([row.wbsId]);
    let parent = row.parentId;

    while (parent !== undefined) {
      if (walked.has(parent)) {
        problems.push({
          kind: 'cycle',
          wbsId: row.wbsId,
          detail: 'The hierarchy loops back on itself.',
        });
        break;
      }

      walked.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }

  /* Predecessor graph, depth-first with a colour per node. */
  const state = new Map<string, 'open' | 'done'>();

  const visit = (id: string, path: readonly string[]): void => {
    if (state.get(id) === 'done') {
      return;
    }

    if (state.get(id) === 'open') {
      problems.push({
        kind: 'cycle',
        wbsId: id,
        detail: `These wait for each other: ${[...path, id].join(' → ')}.`,
      });

      return;
    }

    state.set(id, 'open');

    for (const predecessor of byId.get(id)?.predecessors ?? []) {
      if (byId.has(predecessor)) {
        visit(predecessor, [...path, id]);
      }
    }

    state.set(id, 'done');
  };

  for (const row of rows) {
    visit(row.wbsId, []);
  }

  return problems;
}

/** The next outline number under a parent, given its existing children. */
export function nextOutlineNumber(
  parentId: string | undefined,
  siblings: readonly string[],
): string {
  const prefix = parentId === undefined ? '' : `${parentId}.`;
  const highest = siblings.reduce((best, id) => {
    if (!id.startsWith(prefix)) {
      return best;
    }

    const tail = id.slice(prefix.length);

    return /^\d+$/.test(tail) ? Math.max(best, Number(tail)) : best;
  }, 0);

  return `${prefix}${highest + 1}`;
}

/* --------------------------------------------------------- write shapes */

/** What a model may return for a WBS task: wording and grouping, nothing else. */
export const wbsTaskDraftSchema = z
  .object({
    /** The estimate unit this task belongs to. Verified before storage. */
    estimateUnitId: z.string().min(1).max(64),
    phase: z.string().max(200),
    module: z.string().max(200),
    submodule: z.string().max(200),
    task: z.string().min(1).max(300),
    description: z.string().max(2_000),
    deliverable: z.string().max(300),
    /**
     * A proposed split of this unit's work into named parts.
     *
     * Names and relative sizes only. The hours are allocated by the application from
     * the approved figure — there is nowhere here to put one.
     */
    parts: z
      .array(
        z
          .object({
            task: z.string().min(1).max(300),
            description: z.string().max(2_000),
            /** Relative size, 1–10. Not hours, and never treated as hours. */
            weight: z.number().min(1).max(10),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict();

export type WbsTaskDraft = z.infer<typeof wbsTaskDraftSchema>;

/* --------------------------------------------- the derived reverse index */

/**
 * One client dependency, as seen from the work package that waits for it.
 *
 * A projection, not stored content. The Client Dependency Sheet owns the relationship
 * in its own `wbsIds`; this is that relationship read backwards so somebody looking at a
 * task can see what it is waiting on.
 *
 * `sheetStatus` and `sheetCurrentness` travel with every entry because the answer is
 * only as good as the document it came from. A reverse link into an approved-but-stale
 * sheet is still worth showing — the client dependency probably still exists — but a
 * reader has to be told, or the breakdown appears to make a current claim it cannot
 * support.
 */
export const relatedDependencySchema = z
  .object({
    dependencyKey: z.string().max(64),
    dependency: z.string().max(300),
    category: z.string().max(40),
    status: z.string().max(40),
    blocking: z.string().max(40),
    /** True when this is outstanding and something is waiting on it. */
    blockingOutstanding: z.boolean(),
    /** The state of the sheet this came from, so a stale answer says so. */
    sheetStatus: z.string().max(40),
    sheetCurrentness: z.enum(['CURRENT', 'OUTDATED']),
  })
  .strict();

export type RelatedDependency = z.infer<typeof relatedDependencySchema>;

export const reverseDependencyIndexSchema = z
  .object({
    /** Keyed by WBS outline number. Absent keys have nothing waiting on them. */
    byWbsId: z.record(z.string().max(64), z.array(relatedDependencySchema).max(40)),
    /** The sheet these links were derived from, or null when there is none yet. */
    sheetVersion: z.number().int().nonnegative().nullable(),
    sheetStatus: z.string().max(40).nullable(),
    sheetCurrentness: z.enum(['CURRENT', 'OUTDATED']).nullable(),
  })
  .strict();

export type ReverseDependencyIndex = z.infer<typeof reverseDependencyIndexSchema>;

/**
 * Turn the sheet's forward links into the reverse view a work package needs.
 *
 * Pure, so the engine can compute it on every read without a stored copy that could
 * disagree with the sheet. A dependency naming three tasks appears against all three; a
 * task waiting on two dependencies lists both.
 */
export function reverseDependencyIndex(input: {
  readonly dependencies: readonly {
    readonly dependencyKey: string;
    readonly dependency: string;
    readonly category: string;
    readonly status: string;
    readonly blocking: string;
    readonly wbsIds: readonly string[];
    readonly satisfied: boolean;
  }[];
  readonly sheetVersion: number | null;
  readonly sheetStatus: string | null;
  readonly sheetCurrentness: 'CURRENT' | 'OUTDATED' | null;
}): ReverseDependencyIndex {
  const byWbsId: Record<string, RelatedDependency[]> = {};

  for (const dependency of input.dependencies) {
    for (const wbsId of dependency.wbsIds) {
      const entry: RelatedDependency = {
        dependencyKey: dependency.dependencyKey,
        dependency: dependency.dependency,
        category: dependency.category,
        status: dependency.status,
        blocking: dependency.blocking,
        blockingOutstanding: dependency.blocking !== 'NONE' && !dependency.satisfied,
        sheetStatus: input.sheetStatus ?? 'NOT_STARTED',
        sheetCurrentness: input.sheetCurrentness ?? 'CURRENT',
      };

      byWbsId[wbsId] = [...(byWbsId[wbsId] ?? []), entry];
    }
  }

  return {
    byWbsId,
    sheetVersion: input.sheetVersion,
    sheetStatus: input.sheetStatus,
    sheetCurrentness: input.sheetCurrentness,
  };
}
