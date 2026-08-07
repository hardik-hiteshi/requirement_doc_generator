import { z } from 'zod';

import { PROJECT_TYPES } from '../project/project-type.contract';
import { compatibilityFindingSchema, riskLevelSchema } from './compatibility.contract';
import { stackComponentSchema } from './stack-component.contract';
import { stackSelectionModeSchema } from './stack-authority.contract';
import { categoryApplicabilityEntrySchema } from './technology-category.contract';

/**
 * The stack at a point in time — and, once locked, the stack every later phase
 * is required to use.
 *
 * The counterpart to Phase 4's baseline, and it inherits that phase's two hard
 * rules. **Approval is gated by things that can be enumerated**: every blocker
 * is computed from stored data and says what to do about it. **Versions
 * supersede, never overwrite**: a locked snapshot whose baseline has since
 * changed becomes `OUTDATED` and still says exactly what it said when it was
 * locked, because that is what the estimate was built on.
 *
 * The addition Phase 5 makes is locking. An approved baseline is a statement
 * about requirements that a later analysis may legitimately revise. A locked
 * stack is a statement about *what will be built*, and Phase 6 prices it — so
 * the lock is a separate, explicit act after approval, and nothing automatic
 * can reach through it.
 */

export const STACK_SNAPSHOT_STATUSES = [
  /** Being worked on. */
  'DRAFT',
  /** Something needs a person: a blocking finding, or a recommendation undecided. */
  'REVIEW_REQUIRED',
  /** Every blocker cleared. Approval is available. */
  'READY_FOR_APPROVAL',
  /** Signed off. Still editable, which is why locking is separate. */
  'APPROVED',
  /** Sealed. Authoritative for Phase 6. Only an explicit unlock reopens it. */
  'LOCKED',
  /** Approved or locked, and the ground it stood on has moved. */
  'OUTDATED',
  /** Replaced by a later version. */
  'SUPERSEDED',
] as const;

export type StackSnapshotStatus = (typeof STACK_SNAPSHOT_STATUSES)[number];
export const stackSnapshotStatusSchema = z.enum(STACK_SNAPSHOT_STATUSES);

export const STACK_SNAPSHOT_STATUS_LABELS: Readonly<Record<StackSnapshotStatus, string>> = {
  DRAFT: 'Draft',
  REVIEW_REQUIRED: 'Needs your review',
  READY_FOR_APPROVAL: 'Ready to approve',
  APPROVED: 'Approved',
  LOCKED: 'Locked',
  OUTDATED: 'Out of date',
  SUPERSEDED: 'Superseded',
};

export const STACK_SNAPSHOT_TRANSITIONS: Readonly<
  Record<StackSnapshotStatus, readonly StackSnapshotStatus[]>
> = {
  DRAFT: ['REVIEW_REQUIRED', 'READY_FOR_APPROVAL', 'SUPERSEDED'],
  REVIEW_REQUIRED: ['DRAFT', 'READY_FOR_APPROVAL', 'SUPERSEDED'],
  READY_FOR_APPROVAL: ['DRAFT', 'REVIEW_REQUIRED', 'APPROVED', 'SUPERSEDED'],
  APPROVED: ['LOCKED', 'DRAFT', 'OUTDATED', 'SUPERSEDED'],
  // Unlock returns it to APPROVED. Nothing else gets out.
  LOCKED: ['APPROVED', 'OUTDATED', 'SUPERSEDED'],
  OUTDATED: ['DRAFT', 'SUPERSEDED'],
  SUPERSEDED: [],
};

export function canTransitionSnapshot(from: StackSnapshotStatus, to: StackSnapshotStatus): boolean {
  return from === to || (STACK_SNAPSHOT_TRANSITIONS[from]?.includes(to) ?? false);
}

/** Statuses in which a person has committed to the stack. */
export const SETTLED_SNAPSHOT_STATUSES: readonly StackSnapshotStatus[] = ['APPROVED', 'LOCKED'];

/* --------------------------------------------------------- blockers */

export const STACK_BLOCKER_KINDS = [
  /** A required category with nothing decided in it. */
  'undecided_required_category',
  /** A deterministic BLOCKING compatibility finding. */
  'blocking_compatibility',
  /** A HIGH finding nobody has acknowledged. */
  'unacknowledged_risk',
  /** A recommendation still sitting there, neither accepted nor rejected. */
  'undecided_recommendation',
  /** The baseline this was built from is no longer the current one. */
  'baseline_not_current',
  /** No approved baseline at all. */
  'baseline_not_approved',
  /** The project type is `OTHER` or absent, so nothing can be planned. */
  'project_type_unconfirmed',
  /**
   * The project type changed after the stack was decided.
   *
   * Which categories the project even has follows from the type, so this is not
   * a detail — a stack decided as a web application and now describing an API
   * service may be holding a frontend nobody is paying for.
   */
  'project_type_changed',
  /** Nothing in the stack. */
  'empty_stack',
] as const;

export type StackBlockerKind = (typeof STACK_BLOCKER_KINDS)[number];
export const stackBlockerKindSchema = z.enum(STACK_BLOCKER_KINDS);

export const stackBlockerSchema = z
  .object({
    kind: stackBlockerKindSchema,
    count: z.number().int().positive(),
    summary: z.string().min(1).max(300),
    /** Always actionable. A gate that will not say why gets routed around. */
    action: z.string().min(1).max(300),
    componentIds: z.array(z.string().max(64)).max(60),
    findingIds: z.array(z.string().max(64)).max(60),
  })
  .strict();

export type StackBlocker = z.infer<typeof stackBlockerSchema>;

/* ------------------------------------------------------ user decisions */

/** Every act a person took, so the record shows who decided what. */
export const STACK_DECISION_KINDS = [
  'mode_selected',
  'component_selected',
  'recommendation_accepted',
  'recommendation_rejected',
  'component_replaced',
  'component_locked',
  'component_unlocked',
  'risk_acknowledged',
  'stack_approved',
  'stack_locked',
  'stack_reopened',
] as const;

export type StackDecisionKind = (typeof STACK_DECISION_KINDS)[number];

export const stackDecisionSchema = z
  .object({
    kind: z.enum(STACK_DECISION_KINDS),
    category: z.string().max(40).optional(),
    componentId: z.string().max(64).optional(),
    /** Technology names, which are the user's own words or catalogue names. */
    technologyName: z.string().max(120).optional(),
    previousTechnologyName: z.string().max(120).optional(),
    note: z.string().max(1000),
    decidedAt: z.iso.datetime(),
  })
  .strict();

export type StackDecision = z.infer<typeof stackDecisionSchema>;

/* ------------------------------------------------------ outdated reasons */

export const STACK_OUTDATED_REASONS = [
  'baseline_superseded',
  'baseline_outdated',
  'project_type_changed',
  'clarification_changed_requirements',
  'component_unlocked',
] as const;

export type StackOutdatedReason = (typeof STACK_OUTDATED_REASONS)[number];
export const stackOutdatedReasonSchema = z.enum(STACK_OUTDATED_REASONS);

export const STACK_OUTDATED_MESSAGES: Readonly<Record<StackOutdatedReason, string>> = {
  baseline_superseded: 'A newer requirement baseline has been approved since this stack was set.',
  baseline_outdated: 'The requirement baseline this stack was built from has gone out of date.',
  project_type_changed: 'The project type changed after this stack was set.',
  clarification_changed_requirements:
    'A confirmed clarification changed requirements this stack was built from.',
  component_unlocked: 'A locked technology was unlocked and changed.',
};

/* ------------------------------------------------------------ snapshot */

export const STACK_SCHEMA_VERSION = 1;

export const stackSnapshotSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    /** 1-based, per project. Shown as "Stack v2". */
    version: z.number().int().positive(),
    status: stackSnapshotStatusSchema,
    selectionMode: stackSelectionModeSchema,
    /** The approved baseline this was built from, by id and by version. */
    baselineId: z.string().max(64).optional(),
    baselineVersion: z.number().int().positive().optional(),
    /**
     * The project types as they stood when this snapshot was made.
     *
     * Stored rather than read live, so a later change to the project is
     * detectable — that comparison is what marks a stack out of date.
     */
    projectTypes: z.array(z.enum(PROJECT_TYPES)).max(8),
    categoryPlan: z.array(categoryApplicabilityEntrySchema).max(40),
    components: z.array(stackComponentSchema).max(80),
    compatibilityFindings: z.array(compatibilityFindingSchema).max(120),
    highestRisk: riskLevelSchema,
    blockers: z.array(stackBlockerSchema).max(20),
    decisions: z.array(stackDecisionSchema).max(400),
    /** The most recent recommendation run, for the UI and for the record. */
    lastRecommendationRunId: z.string().max(64).optional(),
    createdAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().optional(),
    approvalNote: z.string().max(2000).optional(),
    lockedAt: z.iso.datetime().optional(),
    outdatedAt: z.iso.datetime().optional(),
    outdatedReason: stackOutdatedReasonSchema.optional(),
    supersededByVersion: z.number().int().positive().optional(),
    updatedAt: z.iso.datetime(),
    /** Optimistic concurrency for the row, distinct from the user-facing version. */
    recordVersion: z.number().int().nonnegative(),
    /** Bumped when the stored shape changes, so a reader knows what it has. */
    schemaVersion: z.number().int().positive(),
  })
  .strict();

export type StackSnapshot = z.infer<typeof stackSnapshotSchema>;

export const approveStackSchema = z
  .object({
    note: z.string().max(2000).optional(),
    /**
     * The same explicit acknowledgement Phase 4 requires, for the same reason.
     *
     * A stack drafted with a model's help is still a commitment a person makes.
     */
    acknowledgedAiAssistance: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ApproveStack = z.infer<typeof approveStackSchema>;

export const lockStackSchema = z
  .object({
    /**
     * That the user understands what locking does.
     *
     * Locking is what makes this authoritative for every later phase. Doing it
     * by accident means an estimate built on a stack nobody meant to commit to.
     */
    acknowledgedDownstreamAuthority: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type LockStack = z.infer<typeof lockStackSchema>;

export const unlockStackSchema = z
  .object({
    reason: z.string().min(1).max(600),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type UnlockStack = z.infer<typeof unlockStackSchema>;

/**
 * Whether the stack may be approved.
 *
 * The one function the approval endpoint calls. Blockers are computed
 * separately and passed in, so this stays a statement about state rather than a
 * second place the rules live.
 */
export function canApproveStack(
  snapshot: Pick<StackSnapshot, 'status' | 'blockers' | 'components'>,
): boolean {
  return (
    (snapshot.status === 'DRAFT' ||
      snapshot.status === 'REVIEW_REQUIRED' ||
      snapshot.status === 'READY_FOR_APPROVAL') &&
    snapshot.blockers.length === 0 &&
    snapshot.components.length > 0
  );
}

export function canLockStack(snapshot: Pick<StackSnapshot, 'status'>): boolean {
  return snapshot.status === 'APPROVED';
}

/**
 * The sentence shown wherever a stack is displayed.
 *
 * Says the two things a reader needs at the moment they are looking at it: a
 * model may have drafted this, and their own choices were not overruled.
 */
export const STACK_AI_NOTICE =
  'Suggestions come from a self-hosted AI model reading your approved requirements. Anything you chose yourself is kept exactly as you set it — the AI can warn about it, never replace it.';
