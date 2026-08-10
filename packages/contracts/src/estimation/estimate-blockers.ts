import type { DependencyProblem } from './dependency.contract';
import type { EstimateUnit } from './estimate-unit.contract';
import { isPlausibleHours } from './productivity-model';
import { feasibilityNeedsAcknowledgement, type FeasibilityStatus } from './feasibility';
import type { EstimateBlocker } from './estimate-snapshot.contract';

/**
 * Everything standing between an estimate and approval.
 *
 * The same discipline as Phases 4 and 5: computed from stored data, each naming
 * what to do about it, and approval with any present is refused.
 *
 * One entry is different in kind from the rest. `unacknowledged_risk` does not
 * mean the plan is wrong — it means the plan says the deadline is tight and
 * nobody has said out loud that they know. Acknowledging clears it and the plan
 * is unchanged, which is exactly the point: this application will not stop a
 * user committing to a hard deadline, and it will not let them do it by
 * accident.
 */

export interface EstimateBlockerInput {
  readonly estimates: readonly EstimateUnit[];
  readonly dependencyProblems: readonly DependencyProblem[];
  /** Approved requirement ids that must all be covered by some estimate. */
  readonly baselineRequirementIds: readonly string[];
  readonly baselineApproved: boolean;
  readonly baselineCurrent: boolean;
  readonly stackLocked: boolean;
  readonly stackCurrent: boolean;
  readonly timelinePresent: boolean;
  /** A fixed deadline that falls before a concrete start date. */
  readonly deadlinePrecedesStart: boolean;
  readonly feasibilityStatus: FeasibilityStatus;
  readonly riskAcknowledgedStatus?: string;
}

export function calculateEstimateBlockers(input: EstimateBlockerInput): readonly EstimateBlocker[] {
  const blockers: EstimateBlocker[] = [];

  /*
   * The upstream gates come first and return early. Nothing below them means
   * anything: an estimate against draft requirements or an unlocked stack is an
   * estimate of something nobody has agreed to build.
   */
  if (!input.baselineApproved) {
    return [
      {
        kind: 'baseline_not_approved',
        count: 1,
        summary: 'Your requirement baseline has not been approved.',
        action: 'Approve the baseline first — the estimate is built from it.',
        subjectIds: [],
      },
    ];
  }

  if (!input.stackLocked) {
    return [
      {
        kind: 'stack_not_locked',
        count: 1,
        summary: 'The technology stack has not been locked.',
        action: 'Lock the stack — what is being built with changes what it costs.',
        subjectIds: [],
      },
    ];
  }

  if (!input.timelinePresent) {
    return [
      {
        kind: 'timeline_missing',
        count: 1,
        summary: 'No delivery timeline has been set.',
        action:
          'Set the delivery timeline in project details. It is what feasibility is measured against.',
        subjectIds: [],
      },
    ];
  }

  /*
   * Two dates that cannot both be true. Returned early like the gates above,
   * because a negative span makes every schedule and capacity figure below it
   * meaningless — and the application will not resolve the contradiction by
   * choosing one of the dates for the user.
   */
  if (input.deadlinePrecedesStart) {
    return [
      {
        kind: 'deadline_before_start',
        count: 1,
        summary: 'The delivery deadline falls before the start date.',
        action:
          'Move the deadline or the start date in project details — whichever is the wrong one.',
        subjectIds: [],
      },
    ];
  }

  if (!input.baselineCurrent) {
    blockers.push({
      kind: 'baseline_not_current',
      count: 1,
      summary: 'The requirements changed after this estimate was made.',
      action: 'Review the estimate against the current baseline, then approve.',
      subjectIds: [],
    });
  }

  if (!input.stackCurrent) {
    blockers.push({
      kind: 'stack_not_current',
      count: 1,
      summary: 'The technology stack changed after this estimate was made.',
      action: 'Review the estimate against the current locked stack, then approve.',
      subjectIds: [],
    });
  }

  const counted = input.estimates.filter((estimate) => !estimate.excluded);

  if (counted.length === 0) {
    blockers.push({
      kind: 'no_estimates',
      count: 1,
      summary: 'Nothing has been estimated yet.',
      action: 'Run the estimation, or add estimates by hand.',
      subjectIds: [],
    });

    return blockers;
  }

  /*
   * Every approved requirement has to reach a disposition: estimated, or
   * explicitly excluded with a reason. A requirement that is simply absent from
   * the plan is work somebody will discover during delivery.
   */
  const covered = new Set(input.estimates.flatMap((estimate) => estimate.requirementIds));
  const uncovered = input.baselineRequirementIds.filter((id) => !covered.has(id));

  if (uncovered.length > 0) {
    blockers.push({
      kind: 'requirement_unestimated',
      count: uncovered.length,
      summary: `${uncovered.length} approved requirement${uncovered.length === 1 ? ' has' : 's have'} no estimate.`,
      action: 'Estimate them, or exclude them from the plan with a reason.',
      subjectIds: uncovered.slice(0, 200),
    });
  }

  /*
   * A negative or absurd hours figure is a typo, including in a user override —
   * and storing it corrupts every total above it, so it is refused rather than
   * respected.
   */
  const invalid = counted.filter((estimate) =>
    Object.values(estimate.effort).some((hours) => !isPlausibleHours(hours)),
  );

  if (invalid.length > 0) {
    blockers.push({
      kind: 'invalid_hours',
      count: invalid.length,
      summary: `${invalid.length} estimate${invalid.length === 1 ? ' has' : 's have'} an impossible number of hours.`,
      action: 'Correct them — hours cannot be negative or unbounded.',
      subjectIds: invalid.map((estimate) => estimate.id),
    });
  }

  const cycles = input.dependencyProblems.filter((problem) => problem.blocking);

  if (cycles.length > 0) {
    blockers.push({
      kind: 'dependency_cycle',
      count: cycles.length,
      summary: `${cycles.length} set${cycles.length === 1 ? '' : 's'} of tasks wait for each other in a loop.`,
      action: 'Remove one link in each loop — a schedule cannot be calculated around it.',
      subjectIds: cycles.flatMap((problem) => problem.ids),
    });
  }

  /*
   * Not "the deadline is unachievable, so you may not approve". The user may
   * approve a plan they know is high risk. What they may not do is approve one
   * without having said so.
   */
  if (
    feasibilityNeedsAcknowledgement(input.feasibilityStatus) &&
    input.riskAcknowledgedStatus !== input.feasibilityStatus
  ) {
    blockers.push({
      kind: 'unacknowledged_risk',
      count: 1,
      summary: 'The delivery timeline is at risk and nobody has acknowledged it.',
      action: 'Read the feasibility above and confirm you are proceeding anyway.',
      subjectIds: [],
    });
  }

  return blockers;
}
