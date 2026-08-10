import { z } from 'zod';

import { documentReferenceSchema } from './document-section.contract';

/**
 * One implementable feature, as a row.
 *
 * ## The internal model is richer than the export
 *
 * The strict CSV has eight columns and four of them are hours. A real project
 * has more roles than that — mobile, UI/UX, DevOps, BA, PM, solution architect,
 * AI/ML — and collapsing them at generation time would throw away the only
 * record of who the work belongs to. So the row keeps every role, and the CSV is
 * a *projection*: backend, frontend and QA get their own columns, and everything
 * else is rendered into the eighth as `"Mobile Dev: 12 | UI/UX: 4"`.
 *
 * Losing the internal model to fit a spreadsheet is how a plan stops being
 * auditable. See `feature-csv.ts` for the projection.
 *
 * ## Hours are not ours to invent
 *
 * Every figure on a row comes from the approved Phase 6 estimate, aggregated
 * deterministically across the estimate units that support the feature. The
 * generation task that produces rows cannot return an hours field at all — its
 * schema has nowhere to put one. A user who wants different hours is sent to the
 * estimation step, where changing them is a recorded decision with its own
 * re-approval, rather than an untracked edit in a document.
 */

/**
 * Roles that get their own CSV column, in column order.
 *
 * Fixed by the export schema rather than by the role model, which is why they
 * are listed separately from `ESTIMATION_ROLES`.
 */
export const CSV_ROLE_COLUMNS = ['BACKEND', 'FRONTEND', 'QA'] as const;
export type CsvRoleColumn = (typeof CSV_ROLE_COLUMNS)[number];

/** How a role is written in the "Other Roles" column. */
export const OTHER_ROLE_LABELS: Readonly<Record<string, string>> = {
  MOBILE: 'Mobile Dev',
  UI_UX: 'UI/UX',
  DEVOPS: 'DevOps',
  BUSINESS_ANALYST: 'BA',
  PROJECT_MANAGER: 'PM',
  SOLUTION_ARCHITECT: 'SA',
  AI_ML: 'AI/ML',
  DATA_ENGINEER: 'Data Engineer',
  SECURITY: 'Security',
  TECHNICAL_WRITER: 'Technical Writer',
};

export const FEATURE_LIMITS = {
  module: { max: 200 },
  submodule: { max: 200 },
  screen: { max: 200 },
  description: { max: 4_000 },
  notes: { max: 1_000 },
  perDocument: 2_000,
  detailPoints: 40,
} as const;

/** The separator for multiple points inside one description. Fixed by the spec. */
export const DETAIL_SEPARATOR = '|';

/**
 * How a feature relates to the requirements it came from.
 *
 * `NOT_APPLICABLE` is a disposition, not an absence: a requirement deliberately
 * left out of the feature list is a decision somebody made, and coverage
 * arithmetic counts it as handled. A requirement nobody has decided about is
 * `UNRESOLVED`, and that is what stops coverage reaching 100%.
 */
export const FEATURE_REVIEW_STATUSES = ['GENERATED', 'USER_EDITED', 'USER_AUTHORED'] as const;
export type FeatureReviewStatus = (typeof FEATURE_REVIEW_STATUSES)[number];

export const featureRowSchema = z
  .object({
    featureId: z.string().min(1).max(64),
    /** Requirements this feature implements. Verified against the baseline. */
    requirementIds: z.array(z.string().max(64)).max(50),
    module: z.string().min(1).max(FEATURE_LIMITS.module.max),
    /** Empty when the module has no meaningful subdivision. */
    submodule: z.string().max(FEATURE_LIMITS.submodule.max),
    /**
     * The screen, interface or component.
     *
     * Legitimately empty for work with no interface — an API endpoint is not a
     * screen, and calling it one to fill a column is a lie in a client document.
     */
    screen: z.string().max(FEATURE_LIMITS.screen.max),
    description: z.string().min(1).max(FEATURE_LIMITS.description.max),
    /** Hours per role, from the approved estimate. Keyed by role id. */
    effort: z.record(z.string().max(60), z.number().min(0)),
    totalHours: z.number().min(0),
    /** Estimate units aggregated into this row. */
    estimateUnitIds: z.array(z.string().max(64)).max(100),
    /** Locked-stack components this feature is built with. */
    technologyIds: z.array(z.string().max(64)).max(40),
    references: z.array(documentReferenceSchema).max(100),
    reviewStatus: z.enum(FEATURE_REVIEW_STATUSES),
    /** How confident the mapping from requirements to this feature is, 0–1. */
    mappingConfidence: z.number().min(0).max(1),
    notes: z.string().max(FEATURE_LIMITS.notes.max),
    order: z.number().int().nonnegative(),
    /**
     * A rewrite waiting for a decision, on a row somebody edited.
     *
     * The same rule as a prose section: a regeneration that would replace a
     * description a person wrote produces a proposal instead. Only the
     * descriptive fields can ever appear here — there is no proposed effort,
     * because effort is not this document's to propose.
     */
    proposed: z
      .object({
        module: z.string().max(FEATURE_LIMITS.module.max),
        submodule: z.string().max(FEATURE_LIMITS.submodule.max),
        screen: z.string().max(FEATURE_LIMITS.screen.max),
        description: z.string().max(FEATURE_LIMITS.description.max),
      })
      .strict()
      .optional(),
    proposedAt: z.string().datetime().optional(),
  })
  .strict();

export type FeatureRow = z.infer<typeof featureRowSchema>;

/** Whether a row is waiting for a decision about a suggested rewrite. */
export function hasFeatureProposal(row: Pick<FeatureRow, 'proposed'>): boolean {
  return row.proposed !== undefined;
}

/** Whether a regeneration may overwrite this row's wording without asking. */
export function mayReplaceFeatureDirectly(row: Pick<FeatureRow, 'reviewStatus'>): boolean {
  return row.reviewStatus === 'GENERATED';
}

/** Hours across every role on a row, rounded the way the estimate rounds. */
export function featureTotalHours(effort: Readonly<Record<string, number>>): number {
  return Number(
    Object.values(effort)
      .reduce((total, hours) => total + hours, 0)
      .toFixed(2),
  );
}

/** Roles on a row that do not have a column of their own. */
export function otherRoleEffort(
  effort: Readonly<Record<string, number>>,
): readonly { readonly role: string; readonly hours: number }[] {
  return Object.entries(effort)
    .filter(([role, hours]) => hours > 0 && !CSV_ROLE_COLUMNS.includes(role as CsvRoleColumn))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([role, hours]) => ({ role, hours }));
}

/* -------------------------------------------------------------- coverage */

/**
 * Feature-list coverage, from requirement disposition and nothing else.
 *
 * `percentage` is computed, never asserted. A document claiming complete
 * coverage while requirements sit unresolved is the single most expensive lie
 * this application could tell — it is exactly the thing somebody signs.
 */
export const featureCoverageSchema = z
  .object({
    /** Approved functional requirements this document is answerable for. */
    applicable: z.number().int().nonnegative(),
    /** Requirements appearing on at least one row. */
    represented: z.number().int().nonnegative(),
    /** Deliberately excluded, with a reason recorded. */
    excluded: z.number().int().nonnegative(),
    /** Neither represented nor excluded. Blocks a complete claim. */
    unresolved: z.number().int().nonnegative(),
    /** Rows citing no approved requirement. */
    unsupportedRows: z.number().int().nonnegative(),
    /** `represented + excluded` over `applicable`, as a percentage. */
    percentage: z.number().min(0).max(100),
    unresolvedRequirementIds: z.array(z.string().max(64)).max(500),
    unsupportedFeatureIds: z.array(z.string().max(64)).max(500),
  })
  .strict();

export type FeatureCoverage = z.infer<typeof featureCoverageSchema>;

export interface CoverageInput {
  readonly applicableRequirementIds: readonly string[];
  readonly rows: readonly Pick<FeatureRow, 'featureId' | 'requirementIds'>[];
  /** Requirement ids a person marked as not applicable to this document. */
  readonly excludedRequirementIds: readonly string[];
}

export function calculateFeatureCoverage(input: CoverageInput): FeatureCoverage {
  const applicable = new Set(input.applicableRequirementIds);
  const excluded = new Set(input.excludedRequirementIds.filter((id) => applicable.has(id)));

  const represented = new Set<string>();
  const unsupported: string[] = [];

  for (const row of input.rows) {
    const supported = row.requirementIds.filter((id) => applicable.has(id));

    if (supported.length === 0) {
      unsupported.push(row.featureId);
    }

    for (const id of supported) {
      represented.add(id);
    }
  }

  const unresolved = [...applicable].filter((id) => !represented.has(id) && !excluded.has(id));
  const handled = represented.size + [...excluded].filter((id) => !represented.has(id)).length;

  return {
    applicable: applicable.size,
    represented: represented.size,
    excluded: excluded.size,
    unresolved: unresolved.length,
    unsupportedRows: unsupported.length,
    percentage: applicable.size === 0 ? 0 : Number(((handled / applicable.size) * 100).toFixed(1)),
    unresolvedRequirementIds: unresolved.sort(),
    unsupportedFeatureIds: unsupported.sort(),
  };
}

/* ---------------------------------------------------- estimate authority */

/**
 * Hours for one feature, aggregated from the estimate units behind it.
 *
 * Deterministic and additive. Two units supporting one feature contribute both
 * their role breakdowns; a unit supporting two features is counted in each,
 * which is why `reconcileFeatureEffort` compares against the *distinct* units
 * rather than the row totals.
 */
export function aggregateFeatureEffort(
  units: readonly { readonly effort: Readonly<Record<string, number>> }[],
): Record<string, number> {
  const total: Record<string, number> = {};

  for (const unit of units) {
    for (const [role, hours] of Object.entries(unit.effort)) {
      total[role] = Number(((total[role] ?? 0) + hours).toFixed(2));
    }
  }

  return total;
}

export const effortReconciliationSchema = z
  .object({
    /** Hours in the approved estimate, for the units this document draws on. */
    estimateHours: z.number().min(0),
    /** Hours across the distinct units cited by the rows. */
    documentHours: z.number().min(0),
    /** Absolute difference. Zero when the document quotes the estimate. */
    differenceHours: z.number().min(0),
    reconciles: z.boolean(),
    /** Units in the estimate that no row cites. */
    uncitedUnitIds: z.array(z.string().max(64)).max(500),
    /** Units a row cites that are not in the approved estimate. */
    unknownUnitIds: z.array(z.string().max(64)).max(500),
  })
  .strict();

export type EffortReconciliation = z.infer<typeof effortReconciliationSchema>;

export interface ReconciliationInput {
  /** Every unit in the approved estimate this document is answerable for. */
  readonly estimateUnits: readonly {
    readonly id: string;
    readonly totalHours: number;
    readonly excluded: boolean;
  }[];
  readonly rows: readonly Pick<FeatureRow, 'estimateUnitIds'>[];
}

/**
 * Whether the document's hours are the estimate's hours.
 *
 * Compared over distinct unit ids, because a unit legitimately supports more
 * than one feature and summing row totals would report a phantom discrepancy
 * every time it does.
 */
export function reconcileFeatureEffort(input: ReconciliationInput): EffortReconciliation {
  const counted = input.estimateUnits.filter((unit) => !unit.excluded);
  const byId = new Map(counted.map((unit) => [unit.id, unit.totalHours]));

  const cited = new Set(input.rows.flatMap((row) => row.estimateUnitIds));
  const unknown = [...cited].filter((id) => !byId.has(id));
  const uncited = counted.filter((unit) => !cited.has(unit.id)).map((unit) => unit.id);

  const estimateHours = Number(
    counted.reduce((total, unit) => total + unit.totalHours, 0).toFixed(2),
  );
  const documentHours = Number(
    [...cited].reduce((total, id) => total + (byId.get(id) ?? 0), 0).toFixed(2),
  );
  const difference = Number(Math.abs(estimateHours - documentHours).toFixed(2));

  return {
    estimateHours,
    documentHours,
    differenceHours: difference,
    reconciles: difference === 0 && unknown.length === 0,
    uncitedUnitIds: uncited.sort(),
    unknownUnitIds: unknown.sort(),
  };
}

/* ----------------------------------------------------------- duplicates */

/**
 * Rows describing the same thing.
 *
 * Compared on module, submodule, screen and a normalised description rather than
 * on the description alone: two rows differing only in punctuation are the same
 * row, and two identically-named screens in different modules are not.
 */
export function findDuplicateFeatures(
  rows: readonly Pick<
    FeatureRow,
    'featureId' | 'module' | 'submodule' | 'screen' | 'description'
  >[],
): readonly (readonly string[])[] {
  const groups = new Map<string, string[]>();

  for (const row of rows) {
    const key = [row.module, row.submodule, row.screen, row.description]
      .map((part) =>
        part
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
      )
      .join('::');

    groups.set(key, [...(groups.get(key) ?? []), row.featureId]);
  }

  return [...groups.values()].filter((ids) => ids.length > 1);
}

/**
 * Module and submodule names that contradict each other.
 *
 * One submodule name appearing under two different modules is usually a
 * generation slip, and it makes the hierarchy in the exported sheet unreadable.
 */
export function inconsistentHierarchy(
  rows: readonly Pick<FeatureRow, 'module' | 'submodule'>[],
): readonly { readonly submodule: string; readonly modules: readonly string[] }[] {
  const byName = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.submodule) {
      continue;
    }

    const key = row.submodule.toLowerCase().trim();
    byName.set(key, (byName.get(key) ?? new Set()).add(row.module));
  }

  return [...byName.entries()]
    .filter(([, modules]) => modules.size > 1)
    .map(([submodule, modules]) => ({ submodule, modules: [...modules].sort() }));
}

/* --------------------------------------------------------- write shapes */

/**
 * Fields a person may change from the document.
 *
 * Descriptive only, and the omission is the design. Hours belong to the
 * estimate; letting a document edit them would fork the number that the
 * commercial proposal is built on, with no record of who changed it or why.
 */
export const EDITABLE_FEATURE_FIELDS = [
  'module',
  'submodule',
  'screen',
  'description',
  'notes',
] as const;

export type EditableFeatureField = (typeof EDITABLE_FEATURE_FIELDS)[number];

export const resolveFeatureProposalSchema = z
  .object({
    decision: z.enum(['KEEP_CURRENT', 'ACCEPT_GENERATED_REVISION', 'EDIT_GENERATED_REVISION']),
    module: z.string().max(FEATURE_LIMITS.module.max).optional(),
    submodule: z.string().max(FEATURE_LIMITS.submodule.max).optional(),
    screen: z.string().max(FEATURE_LIMITS.screen.max).optional(),
    description: z.string().max(FEATURE_LIMITS.description.max).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ResolveFeatureProposal = z.infer<typeof resolveFeatureProposalSchema>;

export const updateFeatureRowSchema = z
  .object({
    module: z.string().min(1).max(FEATURE_LIMITS.module.max).optional(),
    submodule: z.string().max(FEATURE_LIMITS.submodule.max).optional(),
    screen: z.string().max(FEATURE_LIMITS.screen.max).optional(),
    description: z.string().min(1).max(FEATURE_LIMITS.description.max).optional(),
    notes: z.string().max(FEATURE_LIMITS.notes.max).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateFeatureRow = z.infer<typeof updateFeatureRowSchema>;

/**
 * Whether a payload tries to change effort.
 *
 * The schema is strict, so an `effort` key is already refused — this exists to
 * turn that refusal into a message that says where hours are actually changed,
 * rather than "unrecognised key".
 */
export const EFFORT_FIELD_NAMES: readonly string[] = [
  'effort',
  'totalHours',
  'backendHours',
  'frontendHours',
  'qaHours',
  'hours',
  'estimatedHours',
];

export function attemptsEffortEdit(payload: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(payload).some((key) => EFFORT_FIELD_NAMES.includes(key));
}
