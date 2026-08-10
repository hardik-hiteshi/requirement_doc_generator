import { z } from 'zod';

import type { CapacityResult } from './capacity.contract';

/**
 * Whether the work fits in the time the user asked for.
 *
 * The most consequential sentence this application produces, and the one it is
 * most tempting to soften. It does not soften it.
 *
 * **The requested timeline is never changed.** Not extended, not "adjusted for
 * realism", not quietly rounded up. If the work does not fit, the answer is a
 * status, a gap in hours, the capacity that would close it, and the risks — and
 * then the user decides whether to add people, cut scope upstream, accept the
 * risk, or move the date. Four options, all theirs.
 *
 * **`NOT_FEASIBLE_WITH_CURRENT_CAPACITY` is about capacity, not about the
 * project.** The name says so deliberately: it is not "impossible", it is "not
 * with this team", and the difference is the whole conversation.
 */

export const FEASIBILITY_STATUSES = [
  'COMFORTABLE',
  'FEASIBLE',
  'AGGRESSIVE',
  'HIGH_RISK',
  'NOT_FEASIBLE_WITH_CURRENT_CAPACITY',
  /** No team was supplied, so nothing can be said about fit yet. */
  'CAPACITY_UNKNOWN',
  /** A fixed deadline with no start date. The span cannot be measured. */
  'TIMELINE_UNMEASURABLE',
] as const;

export type FeasibilityStatus = (typeof FEASIBILITY_STATUSES)[number];
export const feasibilityStatusSchema = z.enum(FEASIBILITY_STATUSES);

export const FEASIBILITY_LABELS: Readonly<Record<FeasibilityStatus, string>> = {
  COMFORTABLE: 'Comfortable',
  FEASIBLE: 'Achievable',
  AGGRESSIVE: 'Tight',
  HIGH_RISK: 'High risk',
  NOT_FEASIBLE_WITH_CURRENT_CAPACITY: 'Not possible with this team',
  CAPACITY_UNKNOWN: 'Tell us about the team',
  TIMELINE_UNMEASURABLE: 'We need a start date',
};

/**
 * Whether the verdict above is the final word.
 *
 * A fixed delivery deadline with no start date is the case this exists for. The
 * deadline is real, authoritative and kept exactly as the user set it — but a
 * date is not a duration, and until there is a start there is no span for the
 * work to fit into. The honest answer is "not yet fully determinable", together
 * with what is missing. Calling that infeasible would be a claim the data does
 * not support; calling it feasible would be worse.
 */
export const FEASIBILITY_DETERMINACY = ['DETERMINED', 'CONDITIONAL'] as const;

export type FeasibilityDeterminacy = (typeof FEASIBILITY_DETERMINACY)[number];

export const FEASIBILITY_DETERMINACY_LABELS: Readonly<Record<FeasibilityDeterminacy, string>> = {
  DETERMINED: 'Assessed',
  CONDITIONAL: 'Not yet fully determinable',
};

/** What the application would need before it can finish the assessment. */
export const MISSING_INFORMATION_KINDS = ['concrete_start_date', 'team_capacity'] as const;

export type MissingInformationKind = (typeof MISSING_INFORMATION_KINDS)[number];

export const missingInformationSchema = z
  .object({
    kind: z.enum(MISSING_INFORMATION_KINDS),
    summary: z.string().min(1).max(300),
    action: z.string().min(1).max(300),
  })
  .strict();

export type MissingInformation = z.infer<typeof missingInformationSchema>;

/** Statuses a user must explicitly acknowledge before approving. */
export const ACKNOWLEDGEABLE_STATUSES: readonly FeasibilityStatus[] = [
  'AGGRESSIVE',
  'HIGH_RISK',
  'NOT_FEASIBLE_WITH_CURRENT_CAPACITY',
];

export function feasibilityNeedsAcknowledgement(status: FeasibilityStatus): boolean {
  return ACKNOWLEDGEABLE_STATUSES.includes(status);
}

/** Why the timeline is at risk. Each is a fact from the calculation. */
export const TIMELINE_RISK_KINDS = [
  'insufficient_capacity',
  'schedule_exceeds_timeline',
  'role_overloaded',
  'long_critical_path',
  'high_uncertainty_share',
  'unassessed_codebase',
  'external_dependency',
  'client_review_unbudgeted',
  'no_parallelism',
] as const;

export type TimelineRiskKind = (typeof TIMELINE_RISK_KINDS)[number];

export const timelineRiskSchema = z
  .object({
    kind: z.enum(TIMELINE_RISK_KINDS),
    summary: z.string().min(1).max(400),
    /** What could be done about it. Never phrased as an instruction. */
    suggestion: z.string().max(400),
    /** Roles or task ids the risk concerns. */
    subjects: z.array(z.string().max(64)).max(40),
  })
  .strict();

export type TimelineRisk = z.infer<typeof timelineRiskSchema>;

export const feasibilitySchema = z
  .object({
    status: feasibilityStatusSchema,
    /**
     * Whether the verdict is complete. Defaulted so an estimate stored before
     * this field existed still reads back as the assessed case it was.
     */
    determinacy: z.enum(FEASIBILITY_DETERMINACY).default('DETERMINED'),
    /** Empty whenever the verdict is `DETERMINED`. */
    missingInformation: z.array(missingInformationSchema).max(10).default([]),
    /** One sentence saying why, in the user's terms. */
    reason: z.string().min(1).max(600),
    /** Working days the plan needs. */
    requiredWorkingDays: z.number().int().min(0),
    /** Working days the stated timeline allows. Null when unmeasurable. */
    availableWorkingDays: z.number().int().min(0).nullable(),
    /** Working days over. Zero when it fits. */
    scheduleGapDays: z.number().int().min(0),
    requiredHours: z.number().min(0),
    availableHours: z.number().min(0),
    capacityGapHours: z.number().min(0),
    risks: z.array(timelineRiskSchema).max(30),
  })
  .strict();

export type Feasibility = z.infer<typeof feasibilitySchema>;

export interface FeasibilityInput {
  readonly requiredWorkingDays: number;
  readonly availableWorkingDays: number | null;
  readonly capacity: CapacityResult;
  /** Fraction of effort in tasks with high uncertainty, 0–1. */
  readonly highUncertaintyShare: number;
  readonly criticalPathDays: number;
  readonly hasUnassessedCodebase: boolean;
  readonly hasExternalDependency: boolean;
  readonly clientReviewBudgeted: boolean;
  readonly allowParallel: boolean;
}

/**
 * The verdict, from the arithmetic and nothing else.
 *
 * The ordering of the checks matters: the two "we cannot say" answers come
 * first, because reporting `HIGH_RISK` when the real problem is that nobody has
 * told us the team size would be a claim the data does not support.
 */
export function assessFeasibility(input: FeasibilityInput): Feasibility {
  const risks = collectRisks(input);
  const available = input.availableWorkingDays;
  const scheduleGapDays =
    available === null ? 0 : Math.max(0, input.requiredWorkingDays - available);

  const base = {
    determinacy: 'DETERMINED' as FeasibilityDeterminacy,
    missingInformation: [] as MissingInformation[],
    requiredWorkingDays: input.requiredWorkingDays,
    availableWorkingDays: available,
    scheduleGapDays,
    requiredHours: input.capacity.totalPlannedHours,
    availableHours: input.capacity.totalAvailableHours,
    capacityGapHours: input.capacity.totalGapHours,
    risks,
  };

  if (available === null) {
    /*
     * No span, so no availability — and therefore no shortfall either. Reporting
     * the whole plan as a capacity gap would be inventing a deficit out of a
     * missing start date, which is the same failure as inventing the start date.
     * The effort figure stands; everything derived from a calendar does not.
     */
    return {
      ...base,
      status: 'TIMELINE_UNMEASURABLE',
      determinacy: 'CONDITIONAL',
      missingInformation: [
        {
          kind: 'concrete_start_date',
          summary: 'The delivery deadline is fixed, but the project has no start date.',
          action:
            'Set a tentative or confirmed start date. The deadline stays exactly as it is, and the dates, capacity and feasibility are calculated against it.',
        },
        ...(input.capacity.capacityUnknown
          ? [
              {
                kind: 'team_capacity' as const,
                summary: 'Nobody has said who is working on this.',
                action: 'Add the team, or read the recommended staffing below.',
              },
            ]
          : []),
      ],
      availableHours: 0,
      capacityGapHours: 0,
      reason:
        'Your delivery deadline is kept exactly as you set it. There is no start date yet, so there is no span to measure the work against — the effort and the working duration below are final, and the deadline verdict is not yet determinable.',
    };
  }

  if (input.capacity.capacityUnknown) {
    return {
      ...base,
      status: 'CAPACITY_UNKNOWN',
      determinacy: 'CONDITIONAL',
      missingInformation: [
        {
          kind: 'team_capacity',
          summary: 'Nobody has said who is working on this.',
          action: 'Add the team, or read the recommended staffing below.',
        },
      ],
      reason: `The plan needs ${Math.round(input.capacity.totalPlannedHours)} hours over ${available} working days. Tell us who is on the team and we can say whether that fits — or use the recommended staffing below.`,
    };
  }

  /*
   * A capacity shortfall is reported before a schedule overrun, because it is
   * the more fundamental statement: with too few hours, no amount of scheduling
   * helps, whereas a schedule overrun can sometimes be resolved by resequencing.
   */
  if (input.capacity.totalGapHours > 0) {
    return {
      ...base,
      status: 'NOT_FEASIBLE_WITH_CURRENT_CAPACITY',
      reason: `The plan needs ${Math.round(input.capacity.totalPlannedHours)} hours and the team can supply ${Math.round(input.capacity.totalAvailableHours)} in this time — ${Math.round(input.capacity.totalGapHours)} hours short.`,
    };
  }

  if (scheduleGapDays > 0) {
    return {
      ...base,
      status: 'HIGH_RISK',
      reason: `There are enough hours, but the work cannot be sequenced into ${available} working days — it needs ${input.requiredWorkingDays}. Things that must happen in order cannot be shortened by adding people.`,
    };
  }

  const headroom = available === 0 ? 0 : (available - input.requiredWorkingDays) / available;

  if (input.capacity.overloadedRoles.length > 0) {
    return {
      ...base,
      status: 'AGGRESSIVE',
      reason: `It fits, but ${input.capacity.overloadedRoles.length} role${input.capacity.overloadedRoles.length === 1 ? ' is' : 's are'} planned at close to full capacity, which leaves nothing for a sick day or an estimate that was slightly low.`,
    };
  }

  if (headroom < 0.1) {
    return {
      ...base,
      status: 'AGGRESSIVE',
      reason: 'It fits, with almost no room. Anything that goes wrong moves the date.',
    };
  }

  if (headroom < 0.25) {
    return { ...base, status: 'FEASIBLE', reason: 'The work fits the time you have asked for.' };
  }

  return {
    ...base,
    status: 'COMFORTABLE',
    reason: 'The work fits comfortably, with room for the things that always come up.',
  };
}

function collectRisks(input: FeasibilityInput): TimelineRisk[] {
  const risks: TimelineRisk[] = [];

  /*
   * With no span, every capacity figure is zero by arithmetic rather than by
   * measurement — so the risks derived from them would all read as certainties
   * about a calendar nobody has supplied. The risks that come from the work
   * itself are still reported below; they do not depend on a start date.
   */
  const spanKnown = input.availableWorkingDays !== null;

  if (spanKnown && input.capacity.totalGapHours > 0) {
    risks.push({
      kind: 'insufficient_capacity',
      summary: `The team is ${Math.round(input.capacity.totalGapHours)} hours short over this timeline.`,
      suggestion: 'Add capacity, move the date, or reduce scope in the requirements step.',
      subjects: input.capacity.byRole.filter((line) => line.gapHours > 0).map((line) => line.role),
    });
  }

  if (
    input.availableWorkingDays !== null &&
    input.requiredWorkingDays > input.availableWorkingDays
  ) {
    risks.push({
      kind: 'schedule_exceeds_timeline',
      summary: `The sequenced work runs to ${input.requiredWorkingDays} working days against ${input.availableWorkingDays} available.`,
      suggestion: 'Look at the critical path — that is what is setting the length.',
      subjects: [],
    });
  }

  for (const role of spanKnown ? input.capacity.overloadedRoles : []) {
    risks.push({
      kind: 'role_overloaded',
      summary: `${role} is planned above a sustainable load.`,
      suggestion: 'Add someone to this role, or move some of its work out of the timeline.',
      subjects: [role],
    });
  }

  if (
    input.availableWorkingDays !== null &&
    input.availableWorkingDays > 0 &&
    input.criticalPathDays / input.availableWorkingDays > 0.8
  ) {
    risks.push({
      kind: 'long_critical_path',
      summary: `The critical path is ${input.criticalPathDays} working days — most of the available time.`,
      suggestion: 'Any slip on a critical-path task moves the finish date directly.',
      subjects: [],
    });
  }

  if (input.highUncertaintyShare > 0.25) {
    risks.push({
      kind: 'high_uncertainty_share',
      summary: `${Math.round(input.highUncertaintyShare * 100)}% of the effort is in work nobody has enough information about.`,
      suggestion: 'The conservative figure is the one to plan against until those are resolved.',
      subjects: [],
    });
  }

  if (input.hasUnassessedCodebase) {
    risks.push({
      kind: 'unassessed_codebase',
      summary: 'Nobody has looked at the existing codebase.',
      suggestion:
        'A short review before committing to this estimate is usually cheaper than the alternative.',
      subjects: [],
    });
  }

  if (input.hasExternalDependency) {
    risks.push({
      kind: 'external_dependency',
      summary: 'Part of the plan waits on somebody outside the team.',
      suggestion: 'Confirm their availability before the dates are committed to.',
      subjects: [],
    });
  }

  /*
   * Reported as an unknown rather than silently padded. Inventing a two-week
   * client review the client never agreed to is the same failure as inventing
   * anything else.
   */
  if (!input.clientReviewBudgeted) {
    risks.push({
      kind: 'client_review_unbudgeted',
      summary: 'No time is set aside for the client to review anything.',
      suggestion:
        'If they will need time to look at it, set client review days in the calendar rather than absorbing it.',
      subjects: [],
    });
  }

  if (!input.allowParallel) {
    risks.push({
      kind: 'no_parallelism',
      summary: 'Everything is scheduled one thing at a time.',
      suggestion:
        'If more than one person is working, allow parallel work to shorten the schedule.',
      subjects: [],
    });
  }

  return risks;
}

export const acknowledgeFeasibilitySchema = z
  .object({
    /**
     * Explicit, and not a default.
     *
     * Approving a high-risk plan is a decision somebody makes, and the whole
     * value of recording it is that they had to do something.
     */
    acknowledged: z.literal(true),
    note: z.string().max(1_000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AcknowledgeFeasibility = z.infer<typeof acknowledgeFeasibilitySchema>;
