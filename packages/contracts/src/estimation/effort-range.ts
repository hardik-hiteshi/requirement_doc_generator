import { z } from 'zod';

import type { UncertaintyLevel } from './complexity.contract';
import { sumRoleEffort, totalRoleEffort, type RoleEffort } from './role.contract';

/**
 * Three numbers instead of one, because one would be a lie.
 *
 * An estimate is a prediction, and a single figure presented without a range
 * reads as a measurement. The range is not decoration: it is the honest content
 * of the estimate, and the width of it is a statement about how much is known.
 *
 * ## The spread comes from uncertainty, not from a habit
 *
 * A well-understood feature gets a narrow band. A feature that depends on an
 * undocumented API gets a wide one. **Nothing is inflated by a flat percentage**
 * — that would move every number without changing what anybody knows, and would
 * make the range uninformative in exactly the cases where it matters most.
 *
 * `EXPECTED` is what planning uses. The other two are what the conversation
 * about risk uses.
 */

export const EFFORT_RANGE_KEYS = ['optimistic', 'expected', 'conservative'] as const;
export type EffortRangeKey = (typeof EFFORT_RANGE_KEYS)[number];

export const EFFORT_RANGE_LABELS: Readonly<Record<EffortRangeKey, string>> = {
  optimistic: 'If it goes well',
  expected: 'Expected',
  conservative: 'If it does not',
};

/**
 * How far each band sits from the expected figure, per uncertainty level.
 *
 * Asymmetric on purpose. Software work overruns far more often than it comes in
 * early, so the conservative band is further from expected than the optimistic
 * one. A symmetric range would imply the two outcomes are equally likely, which
 * nobody who has shipped software believes.
 */
export const RANGE_SPREADS: Readonly<
  Record<UncertaintyLevel, { readonly optimistic: number; readonly conservative: number }>
> = {
  LOW: { optimistic: 0.9, conservative: 1.15 },
  MEDIUM: { optimistic: 0.8, conservative: 1.4 },
  HIGH: { optimistic: 0.7, conservative: 1.9 },
};

export const effortRangeSchema = z
  .object({
    optimistic: z.number().min(0),
    expected: z.number().min(0),
    conservative: z.number().min(0),
  })
  .strict()
  .refine(
    (range) => range.optimistic <= range.expected && range.expected <= range.conservative,
    'The bands must be ordered: optimistic ≤ expected ≤ conservative',
  );

export type EffortRange = z.infer<typeof effortRangeSchema>;

/** The range around an expected figure, given how much is known about it. */
export function rangeFor(expected: number, uncertainty: UncertaintyLevel): EffortRange {
  const spread = RANGE_SPREADS[uncertainty];

  return {
    optimistic: Number((expected * spread.optimistic).toFixed(2)),
    expected: Number(expected.toFixed(2)),
    conservative: Number((expected * spread.conservative).toFixed(2)),
  };
}

/**
 * Adds ranges.
 *
 * Straight summation of each band, deliberately — not a statistical convolution.
 * Summing the conservative bands assumes everything goes wrong at once, which
 * overstates the true tail; but the alternative requires assuming the features
 * are independent, which they are not, and produces a narrower band that reads
 * as more confident than the underlying knowledge supports. Overstating the tail
 * is the safer error in a document somebody plans against.
 */
export function sumRanges(ranges: readonly EffortRange[]): EffortRange {
  return ranges.reduce<EffortRange>(
    (total, range) => ({
      optimistic: Number((total.optimistic + range.optimistic).toFixed(2)),
      expected: Number((total.expected + range.expected).toFixed(2)),
      conservative: Number((total.conservative + range.conservative).toFixed(2)),
    }),
    { optimistic: 0, expected: 0, conservative: 0 },
  );
}

/** How wide the band is, as a fraction of expected. Shown as a confidence hint. */
export function rangeWidth(range: EffortRange): number {
  if (range.expected === 0) {
    return 0;
  }

  return Number(((range.conservative - range.optimistic) / range.expected).toFixed(3));
}

/* ------------------------------------------------------------- aggregation */

export interface EffortTotals {
  readonly range: EffortRange;
  /** Expected hours per role. The planning numbers. */
  readonly byRole: RoleEffort;
  readonly totalHours: number;
  /** Implementation only, before overhead. Used to compute proportional overhead. */
  readonly implementationHours: number;
  readonly overheadHours: number;
}

export interface EffortContribution {
  readonly range: EffortRange;
  readonly byRole: RoleEffort;
  /** False for overhead lines, so proportional overhead is not applied to itself. */
  readonly isImplementation: boolean;
}

/**
 * Totals across every estimate unit.
 *
 * Keeps implementation and overhead apart in the result, because the overhead
 * rules are expressed as a proportion *of implementation* — folding them
 * together first and then taking a percentage would charge coordination for
 * coordinating the coordination.
 */
export function aggregateEffort(contributions: readonly EffortContribution[]): EffortTotals {
  const range = sumRanges(contributions.map((contribution) => contribution.range));
  const byRole = sumRoleEffort(...contributions.map((contribution) => contribution.byRole));

  const implementationHours = Number(
    contributions
      .filter((contribution) => contribution.isImplementation)
      .reduce((total, contribution) => total + totalRoleEffort(contribution.byRole), 0)
      .toFixed(2),
  );

  const totalHours = totalRoleEffort(byRole);

  return {
    range,
    byRole,
    totalHours,
    implementationHours,
    overheadHours: Number((totalHours - implementationHours).toFixed(2)),
  };
}
