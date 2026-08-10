import { z } from 'zod';

import {
  complexityDriverSchema,
  complexityLevelSchema,
  uncertaintyLevelSchema,
  uncertaintySourceSchema,
} from './complexity.contract';
import { effortRangeSchema } from './effort-range';
import { overheadActivitySchema, taskCategorySchema } from './productivity-model';
import { roleEffortSchema } from './role.contract';

/**
 * One thing that will be built, and what it costs.
 *
 * The row a reviewer reads, and the row every later document is assembled from.
 * Four things about its shape carry the weight of the phase.
 *
 * **It cites requirements.** `requirementIds` are verified against the approved
 * baseline; an estimate for something nobody asked for is a line item a client
 * is being charged for without a reason.
 *
 * **It names its technology drivers.** Every one is a technology id from the
 * *locked* stack. That is what makes "native iOS and native Android need
 * separate implementations" a traceable claim rather than an opinion.
 *
 * **Hours are per role, and roles may be absent.** An absent role means no work
 * of that kind — a different statement from zero, and it reads differently in a
 * breakdown.
 *
 * **The source of every number is recorded.** `AI_PROPOSED`, `USER_OVERRIDE`,
 * `SYSTEM_CALCULATED` — and a user override survives re-estimation, which is
 * the whole reason the field exists.
 */

/* ---------------------------------------------------------- provenance */

export const ESTIMATE_SOURCES = [
  /** The deterministic base rules produced it. */
  'SYSTEM_CALCULATED',
  /** A model proposed the category, complexity and quantity behind it. */
  'AI_PROPOSED',
  /** A person set it. Authoritative until they reset it. */
  'USER_OVERRIDE',
  /** A later AI run, over a slot no person had claimed. */
  'AI_REESTIMATE',
  /** Recalculated from unchanged inputs — a rounding or rules-version change. */
  'SYSTEM_RECALCULATION',
] as const;

export type EstimateSource = (typeof ESTIMATE_SOURCES)[number];
export const estimateSourceSchema = z.enum(ESTIMATE_SOURCES);

export const ESTIMATE_SOURCE_LABELS: Readonly<Record<EstimateSource, string>> = {
  SYSTEM_CALCULATED: 'Calculated',
  AI_PROPOSED: 'Suggested by the AI',
  USER_OVERRIDE: 'Your figure',
  AI_REESTIMATE: 'Re-suggested by the AI',
  SYSTEM_RECALCULATION: 'Recalculated',
};

/**
 * Sources a person set, which nothing automatic may overwrite.
 *
 * The single check that makes override authority real. Every write path that a
 * re-estimation can reach goes through `isUserAuthored`.
 */
export const USER_AUTHORED_SOURCES: readonly EstimateSource[] = ['USER_OVERRIDE'];

export function isUserAuthored(source: EstimateSource): boolean {
  return USER_AUTHORED_SOURCES.includes(source);
}

/* ------------------------------------------------------------- drivers */

/**
 * A reason this costs what it costs, traced to something authoritative.
 *
 * `technologyId` is from the locked stack; `requirementIds` from the approved
 * baseline. A driver that cites neither is an opinion, and is labelled as one by
 * having neither field populated.
 */
export const effortDriverSchema = z
  .object({
    kind: z.enum(['technology', 'integration', 'dependency', 'risk']),
    /** A locked-stack technology id, where the driver is about a technology. */
    technologyId: z.string().max(64).optional(),
    requirementIds: z.array(z.string().max(64)).max(20),
    /** One sentence, in the user's terms. */
    summary: z.string().min(1).max(400),
    /** Extra hours this driver is responsible for, if it is quantified. */
    additionalHours: z.number().min(0).max(2_000).optional(),
  })
  .strict();

export type EffortDriver = z.infer<typeof effortDriverSchema>;

/* -------------------------------------------------------- estimate unit */

export const estimateUnitSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** 1-based within the project. Shown as "E-014". */
    key: z.string().min(1).max(20),
    /** Approved requirements this covers. Verified to exist. */
    requirementIds: z.array(z.string().max(64)).max(50),
    /** Grouping, as the analysis produced it. Free text from the requirements. */
    module: z.string().max(120),
    submodule: z.string().max(120),
    feature: z.string().min(1).max(300),
    taskCategory: taskCategorySchema,
    /** Set on the lines that represent overhead rather than a feature. */
    overheadActivity: overheadActivitySchema.optional(),

    complexity: complexityLevelSchema,
    complexityDrivers: z.array(complexityDriverSchema).max(14),
    complexityExplanation: z.string().max(600),

    uncertainty: uncertaintyLevelSchema,
    uncertaintySources: z.array(uncertaintySourceSchema).max(8),
    uncertaintyExplanation: z.string().max(600),

    /** Hours per role. An absent role means no work of that kind. */
    effort: roleEffortSchema,
    /** Total across roles, at the expected figure. */
    totalHours: z.number().min(0),
    range: effortRangeSchema,

    drivers: z.array(effortDriverSchema).max(20),
    /** Why this figure, for this project. Never "it is a medium feature". */
    rationale: z.string().max(1_500),

    source: estimateSourceSchema,
    /**
     * What it was before a person changed it.
     *
     * Kept so the record shows what was proposed and what was decided, and so
     * "reset to the calculated figure" is possible without re-running anything.
     */
    originalEffort: roleEffortSchema.optional(),
    originalTotalHours: z.number().min(0).optional(),
    overrideNote: z.string().max(1_000).optional(),

    /** Excluded from the plan, and from every total, with a reason. */
    excluded: z.boolean(),
    exclusionReason: z.string().max(600).optional(),

    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type EstimateUnit = z.infer<typeof estimateUnitSchema>;

/** Units that count towards the plan. */
export function isCounted(unit: Pick<EstimateUnit, 'excluded'>): boolean {
  return !unit.excluded;
}

/* --------------------------------------------------------- write shapes */

export const overrideEstimateSchema = z
  .object({
    /** Only the roles being changed. Omitted roles keep their current hours. */
    effort: roleEffortSchema.optional(),
    complexity: complexityLevelSchema.optional(),
    complexityDrivers: z.array(complexityDriverSchema).max(14).optional(),
    uncertainty: uncertaintyLevelSchema.optional(),
    uncertaintySources: z.array(uncertaintySourceSchema).max(8).optional(),
    note: z.string().max(1_000).optional(),
    excluded: z.boolean().optional(),
    exclusionReason: z.string().max(600).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) =>
      input.effort !== undefined ||
      input.complexity !== undefined ||
      input.uncertainty !== undefined ||
      input.excluded !== undefined,
    'Change something',
  );

export type OverrideEstimate = z.infer<typeof overrideEstimateSchema>;

export const resetEstimateSchema = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();

export type ResetEstimate = z.infer<typeof resetEstimateSchema>;

export const manualEstimateSchema = z
  .object({
    feature: z.string().min(1).max(300),
    module: z.string().max(120).optional(),
    submodule: z.string().max(120).optional(),
    taskCategory: taskCategorySchema,
    complexity: complexityLevelSchema,
    complexityDrivers: z.array(complexityDriverSchema).max(14).optional(),
    uncertainty: uncertaintyLevelSchema,
    uncertaintySources: z.array(uncertaintySourceSchema).max(8).optional(),
    /** Hours per role. This is a manual estimate, so the user supplies them. */
    effort: roleEffortSchema,
    requirementIds: z.array(z.string().max(64)).max(50).optional(),
    rationale: z.string().max(1_500).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ManualEstimate = z.infer<typeof manualEstimateSchema>;
