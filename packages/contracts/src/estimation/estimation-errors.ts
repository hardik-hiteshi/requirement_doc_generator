/**
 * Why a Phase 6 request was refused, and what to tell the user about it.
 *
 * The same two rules as every phase before it. **A rejection must be
 * actionable** — it names the problem and, where there is one, the fix. **A
 * rejection must not describe our internals** — that detail goes to the
 * structured log under the correlation id.
 *
 * One rule belongs to this phase. A refusal must never read as though the
 * application disagreed with the user's timeline. `ESTIMATE_HAS_BLOCKERS` on an
 * unacknowledged risk is not "your deadline is unrealistic" — it is "you have
 * not said you have read this", and the wording says so.
 */

export const ESTIMATION_ERROR_CODES = {
  BASELINE_NOT_APPROVED: 'BASELINE_NOT_APPROVED',
  STACK_NOT_LOCKED: 'STACK_NOT_LOCKED',
  TIMELINE_MISSING: 'TIMELINE_MISSING',
  ESTIMATE_NOT_FOUND: 'ESTIMATE_NOT_FOUND',
  ESTIMATE_APPROVED: 'ESTIMATE_APPROVED',
  ESTIMATE_ALREADY_APPROVED: 'ESTIMATE_ALREADY_APPROVED',
  ESTIMATE_NOT_APPROVED: 'ESTIMATE_NOT_APPROVED',
  ESTIMATE_HAS_BLOCKERS: 'ESTIMATE_HAS_BLOCKERS',
  ESTIMATE_UNIT_NOT_FOUND: 'ESTIMATE_UNIT_NOT_FOUND',
  DEPENDENCY_NOT_FOUND: 'DEPENDENCY_NOT_FOUND',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  UNKNOWN_TASK: 'UNKNOWN_TASK',
  UNKNOWN_REQUIREMENT: 'UNKNOWN_REQUIREMENT',
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
  ROLE_NOT_APPLICABLE: 'ROLE_NOT_APPLICABLE',
  IMPLAUSIBLE_HOURS: 'IMPLAUSIBLE_HOURS',
  ESTIMATION_NOT_CONFIGURED: 'ESTIMATION_NOT_CONFIGURED',
  ESTIMATION_ALREADY_RUNNING: 'ESTIMATION_ALREADY_RUNNING',
  ESTIMATION_FAILED: 'ESTIMATION_FAILED',
  NO_RISK_TO_ACKNOWLEDGE: 'NO_RISK_TO_ACKNOWLEDGE',
  ESTIMATE_LIMIT_REACHED: 'ESTIMATE_LIMIT_REACHED',
} as const;

export type EstimationErrorCode =
  (typeof ESTIMATION_ERROR_CODES)[keyof typeof ESTIMATION_ERROR_CODES];

export const ESTIMATION_ERROR_MESSAGES: Readonly<Record<EstimationErrorCode, string>> = {
  BASELINE_NOT_APPROVED:
    'Approve your requirement baseline first. An estimate is built from approved requirements, not draft ones.',
  STACK_NOT_LOCKED:
    'Lock the technology stack first. What the project is built with changes what it costs, so the estimate needs a committed answer.',
  TIMELINE_MISSING:
    'Set the delivery timeline in project details. It is what feasibility is measured against, and it is not guessed.',
  ESTIMATE_NOT_FOUND: 'There is no estimate for this project yet.',
  ESTIMATE_APPROVED:
    'The estimate is approved, so nothing changed. Reopen it if you want to make changes — anything built on it will be marked out of date.',
  ESTIMATE_ALREADY_APPROVED: 'This estimate has already been approved.',
  ESTIMATE_NOT_APPROVED: 'This estimate has not been approved, so there is nothing to reopen.',
  ESTIMATE_HAS_BLOCKERS:
    'Some things still need your attention before this estimate can be approved.',
  ESTIMATE_UNIT_NOT_FOUND: 'That estimate is not part of this project.',
  DEPENDENCY_NOT_FOUND: 'That dependency is not part of this project.',
  DEPENDENCY_CYCLE:
    'That would make a loop — these tasks would each be waiting for the other. A schedule cannot be calculated around it.',
  UNKNOWN_TASK: 'One of the tasks referred to is not in this plan.',
  UNKNOWN_REQUIREMENT: 'One of the requirements cited is not in your approved baseline.',
  UNKNOWN_ROLE: 'That is not a role this project has. Add it as a custom role if you need it.',
  ROLE_NOT_APPLICABLE:
    'That role does not apply to this project — nothing in the locked stack calls for it. If it should, the stack is the place to change.',
  IMPLAUSIBLE_HOURS:
    'Hours cannot be negative, and no single item runs to thousands. Check the figure.',
  ESTIMATION_NOT_CONFIGURED:
    'AI estimation is not switched on for this deployment. You can still estimate everything yourself, approve it and carry on.',
  ESTIMATION_ALREADY_RUNNING: 'An estimation is already running for this project.',
  ESTIMATION_FAILED:
    'The estimation could not be completed. Nothing in your plan was changed — you can retry, or estimate the remaining items yourself.',
  NO_RISK_TO_ACKNOWLEDGE:
    'There is nothing to acknowledge — the timeline is not flagged as at risk.',
  ESTIMATE_LIMIT_REACHED: 'This plan already holds as many estimate lines as one project can have.',
};

/** Limits, so one project cannot become unbounded. */
export const ESTIMATION_LIMITS = {
  maxEstimateUnits: 1_000,
  maxDependencies: 4_000,
  maxMilestones: 60,
  maxCustomRoles: 20,
  maxIntegrations: 60,
  maxVersions: 100,
} as const;
