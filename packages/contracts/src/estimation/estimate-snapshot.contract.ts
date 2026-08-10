import { z } from 'zod';

import { capacityLineSchema, staffingLineSchema, utilisationSchema } from './capacity.contract';
import { workingCalendarSchema } from './calendar.contract';
import { dependencySchema } from './dependency.contract';
import { effortRangeSchema } from './effort-range';
import { estimateUnitSchema } from './estimate-unit.contract';
import { feasibilitySchema } from './feasibility';
import { customEstimationRoleSchema, roleEffortSchema } from './role.contract';
import { scheduleSchema } from './scheduling';

/**
 * The estimate at a point in time.
 *
 * Phase 4 had a baseline; Phase 5 had a locked stack; this is the third
 * artefact in the chain, and it inherits both of their rules. Approval is gated
 * by things that can be enumerated. Versions supersede rather than overwrite.
 *
 * The addition here is a distinction the other two did not need: **some changes
 * invalidate the effort and some only move the dates.** Changing the start date
 * recalculates a schedule and touches nothing else — the hours were never a
 * function of which Monday work begins. Changing the baseline, the locked stack,
 * the timeline or the team materially does invalidate it. Collapsing the two
 * would make an estimate go stale every time somebody picked a date.
 */

/* ---------------------------------------------------------- milestones */

export const MILESTONE_KINDS = [
  'foundation',
  'module_complete',
  'integration_complete',
  'feature_complete',
  'qa_complete',
  'uat',
  'release_readiness',
  'production_deployment',
] as const;

export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export const MILESTONE_LABELS: Readonly<Record<MilestoneKind, string>> = {
  foundation: 'Foundations in place',
  module_complete: 'Module complete',
  integration_complete: 'Integrations complete',
  feature_complete: 'Feature complete',
  qa_complete: 'Testing complete',
  uat: 'User acceptance testing',
  release_readiness: 'Ready to release',
  production_deployment: 'Live',
};

export const milestoneSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(MILESTONE_KINDS),
    label: z.string().min(1).max(200),
    /** Working day from project start. */
    day: z.number().int().min(1),
    /** Only when the project has a concrete start date. */
    date: z.string().max(10).optional(),
    /** Estimate units that must be done for this to be true. */
    taskIds: z.array(z.string().max(64)).max(500),
    userDefined: z.boolean(),
  })
  .strict();

export type Milestone = z.infer<typeof milestoneSchema>;

/* ------------------------------------------------------- existing system */

/**
 * What is known about a codebase the project is changing rather than creating.
 *
 * Every field defaults to "we do not know", and that is reported as
 * uncertainty rather than filled in. A migration estimate built on an invented
 * assessment of somebody's legacy code is the most expensive kind of wrong.
 */
export const existingSystemSchema = z
  .object({
    applies: z.boolean(),
    repositoryReviewed: z.boolean(),
    architectureDocumented: z.boolean(),
    /** 0–1, only when somebody actually measured it. */
    knownTestCoverage: z.number().min(0).max(1).optional(),
    technicalDebtNotes: z.string().max(2_000),
    migrationConstraints: z.string().max(2_000),
  })
  .strict();

export type ExistingSystem = z.infer<typeof existingSystemSchema>;

export const NO_EXISTING_SYSTEM: ExistingSystem = {
  applies: false,
  repositoryReviewed: false,
  architectureDocumented: false,
  technicalDebtNotes: '',
  migrationConstraints: '',
};

export const CODEBASE_NOT_ASSESSED = 'CODEBASE_NOT_ASSESSED';

/* ------------------------------------------------------------ integrations */

/**
 * An external system the project has to talk to.
 *
 * The fields are all questions with checkable answers, and an unknown answer
 * raises uncertainty rather than becoming a cheerful assumption. "The API is
 * probably fine" is not a planning input.
 */
export const integrationEstimateSchema = z
  .object({
    id: z.string().min(1).max(64),
    requirementIds: z.array(z.string().max(64)).max(20),
    provider: z.string().min(1).max(200),
    documentationAvailable: z.boolean(),
    sandboxAvailable: z.boolean(),
    credentialsFromClient: z.boolean(),
    webhooksRequired: z.boolean(),
    errorHandlingRequired: z.boolean(),
    retriesRequired: z.boolean(),
    reconciliationRequired: z.boolean(),
    /** True when testing depends on somebody else's environment being up. */
    testingDependsOnProvider: z.boolean(),
    notes: z.string().max(2_000),
  })
  .strict();

export type IntegrationEstimate = z.infer<typeof integrationEstimateSchema>;

/* -------------------------------------------------------------- snapshot */

export const ESTIMATE_STATUSES = [
  'DRAFT',
  'REVIEW_REQUIRED',
  'READY_FOR_APPROVAL',
  'APPROVED',
  'OUTDATED',
  'SUPERSEDED',
] as const;

export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];
export const estimateStatusSchema = z.enum(ESTIMATE_STATUSES);

export const ESTIMATE_STATUS_LABELS: Readonly<Record<EstimateStatus, string>> = {
  DRAFT: 'Draft',
  REVIEW_REQUIRED: 'Needs your review',
  READY_FOR_APPROVAL: 'Ready to approve',
  APPROVED: 'Approved',
  OUTDATED: 'Out of date',
  SUPERSEDED: 'Superseded',
};

export const ESTIMATE_TRANSITIONS: Readonly<Record<EstimateStatus, readonly EstimateStatus[]>> = {
  DRAFT: ['REVIEW_REQUIRED', 'READY_FOR_APPROVAL', 'SUPERSEDED'],
  REVIEW_REQUIRED: ['DRAFT', 'READY_FOR_APPROVAL', 'SUPERSEDED'],
  READY_FOR_APPROVAL: ['DRAFT', 'REVIEW_REQUIRED', 'APPROVED', 'SUPERSEDED'],
  APPROVED: ['OUTDATED', 'DRAFT', 'SUPERSEDED'],
  OUTDATED: ['DRAFT', 'SUPERSEDED'],
  SUPERSEDED: [],
};

export function canTransitionEstimate(from: EstimateStatus, to: EstimateStatus): boolean {
  return from === to || (ESTIMATE_TRANSITIONS[from]?.includes(to) ?? false);
}

export const ESTIMATE_OUTDATED_REASONS = [
  'baseline_changed',
  'stack_changed',
  'timeline_changed',
  'capacity_changed',
  'calendar_changed',
] as const;

export type EstimateOutdatedReason = (typeof ESTIMATE_OUTDATED_REASONS)[number];

export const ESTIMATE_OUTDATED_MESSAGES: Readonly<Record<EstimateOutdatedReason, string>> = {
  baseline_changed: 'The approved requirements changed after this estimate was made.',
  stack_changed: 'The locked technology stack changed after this estimate was made.',
  timeline_changed: 'The required delivery timeline changed after this estimate was made.',
  capacity_changed: 'The team changed enough to alter what fits.',
  calendar_changed: 'The working calendar changed enough to alter what fits.',
};

/* --------------------------------------------------------------- blockers */

export const ESTIMATE_BLOCKER_KINDS = [
  'baseline_not_approved',
  'baseline_not_current',
  'stack_not_locked',
  'stack_not_current',
  'timeline_missing',
  'no_estimates',
  'requirement_unestimated',
  'invalid_hours',
  'dependency_cycle',
  'unacknowledged_risk',
] as const;

export type EstimateBlockerKind = (typeof ESTIMATE_BLOCKER_KINDS)[number];

export const estimateBlockerSchema = z
  .object({
    kind: z.enum(ESTIMATE_BLOCKER_KINDS),
    count: z.number().int().positive(),
    summary: z.string().min(1).max(300),
    action: z.string().min(1).max(300),
    subjectIds: z.array(z.string().max(64)).max(200),
  })
  .strict();

export type EstimateBlocker = z.infer<typeof estimateBlockerSchema>;

/* -------------------------------------------------------------- snapshot */

export const ESTIMATE_SCHEMA_VERSION = 1;

export const estimateSnapshotSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    version: z.number().int().positive(),
    status: estimateStatusSchema,

    /* What it was calculated against. Stored, so a later change is detectable. */
    baselineId: z.string().max(64).optional(),
    baselineVersion: z.number().int().positive().optional(),
    stackSnapshotId: z.string().max(64).optional(),
    stackVersion: z.number().int().positive().optional(),
    /** A digest of the timeline, so a change to it is one comparison. */
    timelineDigest: z.string().max(128).optional(),
    timelineDescription: z.string().max(200),
    startDateMode: z.string().max(40),
    startDate: z.string().max(10).optional(),

    calendar: workingCalendarSchema,
    team: z.object({ supplied: z.boolean(), lines: z.array(capacityLineSchema).max(60) }).strict(),
    customRoles: z.array(customEstimationRoleSchema).max(20),
    existingSystem: existingSystemSchema,
    integrations: z.array(integrationEstimateSchema).max(60),

    /** Which methodology produced the numbers. Recorded, never guessed at later. */
    productivityModelVersion: z.string().min(1).max(20),
    /**
     * Whether client-facing documents may mention AI assistance.
     *
     * Defaults to false. A proposal that volunteers how the code was written
     * invites a conversation about price that is the user's to start.
     */
    mentionAiAssistance: z.boolean(),

    estimates: z.array(estimateUnitSchema).max(1_000),
    dependencies: z.array(dependencySchema).max(4_000),
    milestones: z.array(milestoneSchema).max(60),

    totalEffort: effortRangeSchema,
    effortByRole: roleEffortSchema,
    implementationHours: z.number().min(0),
    overheadHours: z.number().min(0),

    schedule: scheduleSchema,
    utilisation: z.array(utilisationSchema).max(60),
    recommendedStaffing: z.array(staffingLineSchema).max(60),
    feasibility: feasibilitySchema,

    blockers: z.array(estimateBlockerSchema).max(20),
    /** Recorded when a user approved a tight or high-risk plan anyway. */
    riskAcknowledgedAt: z.iso.datetime().optional(),
    riskAcknowledgementNote: z.string().max(1_000).optional(),
    riskAcknowledgedStatus: z.string().max(60).optional(),

    createdAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().optional(),
    approvalNote: z.string().max(2_000).optional(),
    outdatedAt: z.iso.datetime().optional(),
    outdatedReason: z.enum(ESTIMATE_OUTDATED_REASONS).optional(),
    supersededByVersion: z.number().int().positive().optional(),
    updatedAt: z.iso.datetime(),
    recordVersion: z.number().int().nonnegative(),
    schemaVersion: z.number().int().positive(),
  })
  .strict();

export type EstimateSnapshot = z.infer<typeof estimateSnapshotSchema>;

export const approveEstimateSchema = z
  .object({
    note: z.string().max(2_000).optional(),
    /** The same acknowledgement Phases 4 and 5 require, for the same reason. */
    acknowledgedAiAssistance: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ApproveEstimate = z.infer<typeof approveEstimateSchema>;

export const reopenEstimateSchema = z
  .object({
    reason: z.string().min(1).max(600),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ReopenEstimate = z.infer<typeof reopenEstimateSchema>;

/**
 * Whether the estimate may be approved.
 *
 * **Feasibility is not a condition.** A user may approve a plan that says the
 * deadline is high risk — they have read it and decided to proceed, which is a
 * legitimate commercial decision. What they may not do is approve it without
 * having said so, which the `unacknowledged_risk` blocker enforces.
 */
export function canApproveEstimate(
  snapshot: Pick<EstimateSnapshot, 'status' | 'blockers' | 'estimates'>,
): boolean {
  return (
    (snapshot.status === 'DRAFT' ||
      snapshot.status === 'REVIEW_REQUIRED' ||
      snapshot.status === 'READY_FOR_APPROVAL') &&
    snapshot.blockers.length === 0 &&
    snapshot.estimates.some((estimate) => !estimate.excluded)
  );
}

/**
 * The sentence shown wherever an estimate is displayed.
 *
 * Says the two things a reader needs at the moment they look at it: these are
 * estimates rather than measurements, and the timeline they asked for has not
 * been changed behind their back.
 */
export const ESTIMATE_NOTICE =
  'These are estimates, not measurements — each carries a range, and the range is the honest part. The delivery timeline you set has not been changed; where the work does not fit, that is stated rather than absorbed.';
