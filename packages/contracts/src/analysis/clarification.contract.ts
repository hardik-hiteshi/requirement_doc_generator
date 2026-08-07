import { z } from 'zod';

import { ANALYSIS_LIMITS } from './analysis-limits';
import { missingDimensionSchema } from './findings.contract';

/**
 * A question worth a stakeholder's time, and the answer that settles it.
 *
 * The pressure-release valve for everything the analysis found and cannot
 * settle: a gap, a contradiction, a word nobody defined. The alternative — a
 * model filling the gap with something plausible — produces a document that
 * reads as complete and is wrong in the places nobody will check.
 *
 * ## A confirmed answer is evidence, not an assumption
 *
 * This is the rule the whole file exists to enforce. Ask "which users can
 * approve?", get back "only Project Managers", and the requirement that said
 * *"Users can approve requests"* should come to say *"Only Project Managers can
 * approve requests"* — traced to the clarification, at full evidence weight.
 *
 * It must **not** become `Assumption: Project Managers can approve requests`.
 * An assumption is something nobody confirmed; recording a confirmed fact as one
 * understates what is known and invites a reader to discount it. An assumption
 * is created only when a person explicitly says they are assuming.
 *
 * ## Answers are versioned, and changing one has consequences
 *
 * A confirmed answer that later turns out to be wrong does not get overwritten.
 * A new version supersedes it, the old one stays readable, the requirements it
 * touched are marked for revalidation, and any baseline built on it goes out of
 * date. What was signed stays signed.
 */

export const CLARIFICATION_CATEGORIES = [
  /** A detail the documents do not state. */
  'missing_detail',
  /** Two statements disagree; the client has to say which holds. */
  'conflict',
  /** The wording admits more than one reading. */
  'ambiguity',
  /** A term is used but never defined. */
  'terminology',
  /** Is this in scope at all? */
  'scope',
  /** How will we know this is done? */
  'acceptance',
] as const;

export type ClarificationCategory = (typeof CLARIFICATION_CATEGORIES)[number];
export const clarificationCategorySchema = z.enum(CLARIFICATION_CATEGORIES);

export const CLARIFICATION_CATEGORY_LABELS: Readonly<Record<ClarificationCategory, string>> = {
  missing_detail: 'Missing detail',
  conflict: 'Conflicting statements',
  ambiguity: 'Unclear wording',
  terminology: 'Undefined term',
  scope: 'Scope',
  acceptance: 'Acceptance',
};

/**
 * Where a clarification is in its life.
 *
 * Answering and *confirming* are separate deliberately. An answer typed in a
 * meeting and an answer the client has agreed to are different things, and only
 * the second is evidence. Integration is separate again, because it can fail —
 * and "we have the answer" must not silently become "the requirements reflect
 * it".
 */
export const CLARIFICATION_STATUSES = [
  /** Asked, nothing back yet. */
  'UNANSWERED',
  /** An answer exists but nobody has confirmed it is the client's. */
  'ANSWERED',
  /** Confirmed. From here the answer is authoritative evidence. */
  'CONFIRMED',
  /** Targeted integration is running. */
  'INTEGRATING',
  /** Every affected requirement now reflects the answer. */
  'INTEGRATED',
  /**
   * Integration produced proposals a person has to accept.
   *
   * Reached when the answer touches a requirement somebody edited, created by
   * hand, or already approved — none of which may be rewritten automatically.
   */
  'NEEDS_REVIEW',
  /** Integration failed. The answer and the requirements are untouched. */
  'FAILED',
  /** A later answer version replaced this state. */
  'SUPERSEDED',
  /**
   * A person judged the question not worth asking, with a reason.
   *
   * Not in the lifecycle a client walks through, but a real outcome: some
   * questions turn out to be answered elsewhere, and a reviewer needs a way to
   * say so that clears the blocker without inventing an answer.
   */
  'DISMISSED',
] as const;

export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];
export const clarificationStatusSchema = z.enum(CLARIFICATION_STATUSES);

export const CLARIFICATION_STATUS_LABELS: Readonly<Record<ClarificationStatus, string>> = {
  UNANSWERED: 'Waiting for an answer',
  ANSWERED: 'Answered — confirm it to apply',
  CONFIRMED: 'Confirmed',
  INTEGRATING: 'Applying the answer',
  INTEGRATED: 'Applied',
  NEEDS_REVIEW: 'Needs your review',
  FAILED: 'Could not be applied',
  SUPERSEDED: 'Replaced by a newer answer',
  DISMISSED: 'Dismissed',
};

/** Statuses in which the question is settled enough not to block approval. */
export const SETTLED_CLARIFICATION_STATUSES: readonly ClarificationStatus[] = [
  'INTEGRATED',
  'DISMISSED',
];

/**
 * Permitted transitions.
 *
 * A new answer on a confirmed or integrated question sends it back to
 * `ANSWERED`: the previous answer is superseded and the new one has to be
 * confirmed on its own account.
 */
export const CLARIFICATION_TRANSITIONS: Readonly<
  Record<ClarificationStatus, readonly ClarificationStatus[]>
> = {
  UNANSWERED: ['ANSWERED', 'DISMISSED'],
  ANSWERED: ['ANSWERED', 'CONFIRMED', 'DISMISSED'],
  CONFIRMED: ['INTEGRATING', 'ANSWERED', 'DISMISSED'],
  INTEGRATING: ['INTEGRATED', 'NEEDS_REVIEW', 'FAILED'],
  INTEGRATED: ['ANSWERED', 'NEEDS_REVIEW'],
  NEEDS_REVIEW: ['INTEGRATED', 'ANSWERED'],
  FAILED: ['CONFIRMED', 'ANSWERED', 'DISMISSED'],
  SUPERSEDED: [],
  DISMISSED: ['ANSWERED'],
};

export function canTransitionClarification(
  from: ClarificationStatus,
  to: ClarificationStatus,
): boolean {
  return from === to || (CLARIFICATION_TRANSITIONS[from]?.includes(to) ?? false);
}

export const CLARIFICATION_IMPACTS = ['blocking', 'important', 'nice_to_have'] as const;
export type ClarificationImpact = (typeof CLARIFICATION_IMPACTS)[number];
export const clarificationImpactSchema = z.enum(CLARIFICATION_IMPACTS);

/* ------------------------------------------------------------- answers */

export const ANSWER_STATUSES = ['current', 'superseded'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/**
 * One version of an answer.
 *
 * Kept forever. A requirement traced to "confirmed clarification Q-004" has to
 * be readable against the answer that was current when it was written, not
 * against whatever the answer says today.
 */
export const clarificationAnswerSchema = z
  .object({
    /** 1-based, per clarification. */
    version: z.number().int().positive(),
    text: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    answeredAt: z.iso.datetime(),
    /** Set when a person confirms this is the client's answer. */
    confirmedAt: z.iso.datetime().optional(),
    /**
     * Whether the person answering is *assuming* rather than reporting.
     *
     * Default false, and it changes what gets created: a confirmed fact updates
     * the requirements it affects, while an explicit assumption is recorded as
     * an assumption item labelled as one. The application never chooses this —
     * only the person in the room knows which it is.
     */
    isAssumption: z.boolean(),
    status: z.enum(ANSWER_STATUSES),
    supersededAt: z.iso.datetime().optional(),
    supersededByVersion: z.number().int().positive().optional(),
    /** Requirements this answer version changed or proposed a change to. */
    affectedItemIds: z.array(z.string().max(64)).max(200),
    integratedAt: z.iso.datetime().optional(),
    /** Why integration failed, when it did. Safe to show. */
    failureReason: z.string().max(300).optional(),
  })
  .strict();

export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export const clarificationSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    /** Stable and human-facing: Q-001. Cited by requirements that depend on it. */
    key: z.string().regex(/^Q-\d{3,4}$/),
    question: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    /** Why it is being asked. A question without context is hard to answer. */
    rationale: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    category: clarificationCategorySchema,
    impact: clarificationImpactSchema,
    dimension: missingDimensionSchema.optional(),
    relatedItemIds: z.array(z.string().max(64)).max(50),
    relatedConflictIds: z.array(z.string().max(64)).max(20),
    relatedFindingIds: z.array(z.string().max(64)).max(50),
    status: clarificationStatusSchema,
    /** Every version, oldest first. Never pruned. */
    answers: z.array(clarificationAnswerSchema).max(50),
    dismissedReason: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    /**
     * Whether an unsettled state stops the baseline being approved.
     *
     * Derived from impact when the question is created, but stored rather than
     * recomputed: a person may downgrade it, and that decision has to survive.
     */
    blocksApproval: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type Clarification = z.infer<typeof clarificationSchema>;

/** The answer in force, if there is one. */
export function currentAnswer(clarification: Clarification): ClarificationAnswer | undefined {
  return clarification.answers.find((answer) => answer.status === 'current');
}

/** Whether the answer in force has been confirmed as the client's. */
export function isConfirmed(clarification: Clarification): boolean {
  return currentAnswer(clarification)?.confirmedAt !== undefined;
}

/* ------------------------------------------------------------ requests */

export const answerClarificationSchema = z
  .object({
    text: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    /**
     * Whether this answer is an internal assumption rather than a client fact.
     *
     * Deliberately required rather than defaulted. A confirmed fact updates the
     * requirements it affects; an assumption is recorded as one, labelled, so
     * the client can see what was taken for granted. A default would make that
     * choice for the user, and it is not the application's to make.
     */
    isAssumption: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AnswerClarification = z.infer<typeof answerClarificationSchema>;

export const confirmClarificationSchema = z
  .object({
    /**
     * Explicit acknowledgement that this answer is authoritative.
     *
     * Required, because confirming is what turns text somebody typed into
     * evidence that rewrites requirements. It should not be reachable by
     * accident.
     */
    acknowledged: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ConfirmClarification = z.infer<typeof confirmClarificationSchema>;

export const dismissClarificationSchema = z
  .object({
    reason: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type DismissClarification = z.infer<typeof dismissClarificationSchema>;

/* ---------------------------------------------------------- integration */

export const INTEGRATION_OUTCOMES = [
  /** The requirement was updated automatically. */
  'applied',
  /** A revision is proposed and waiting for a person. */
  'proposed',
  /** The answer turned out not to change this requirement. */
  'unchanged',
  /** The model could not produce a usable revision for it. */
  'failed',
] as const;

export type IntegrationOutcome = (typeof INTEGRATION_OUTCOMES)[number];

/**
 * Why a requirement was proposed rather than updated.
 *
 * Shown to the reviewer, because "we did not touch this" is only reassuring if
 * it comes with the reason.
 */
export const PROPOSAL_REASONS = [
  'manually_edited',
  'user_created',
  'already_approved',
  'accepted_by_user',
] as const;

export type ProposalReason = (typeof PROPOSAL_REASONS)[number];

export const PROPOSAL_REASON_MESSAGES: Readonly<Record<ProposalReason, string>> = {
  manually_edited: 'You edited this requirement, so the change is proposed rather than applied.',
  user_created: 'You wrote this requirement, so it is never rewritten automatically.',
  already_approved:
    'This requirement is part of an approved baseline, so it is not replaced silently.',
  accepted_by_user: 'You accepted this requirement, so the change is proposed rather than applied.',
};

/**
 * A revision waiting for a person.
 *
 * Held on the requirement rather than on the clarification, because the
 * question a reviewer asks is "what is being proposed for *this* requirement",
 * and because a requirement can only have one proposal outstanding at a time.
 */
export const proposedRevisionSchema = z
  .object({
    clarificationId: z.string().min(1).max(64),
    clarificationKey: z.string().max(16),
    /** What it says now, captured when the proposal was made. */
    currentStatement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    proposedStatement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    /** Plain language, for a reviewer. Never raw model output. */
    reason: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    proposalReason: z.enum(PROPOSAL_REASONS),
    proposedAt: z.iso.datetime(),
  })
  .strict();

export type ProposedRevision = z.infer<typeof proposedRevisionSchema>;

export const PROPOSAL_DECISIONS = ['accept', 'reject', 'edit'] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

export const resolveProposalSchema = z
  .object({
    decision: z.enum(PROPOSAL_DECISIONS),
    /** Required for `edit`: the wording the reviewer settled on. */
    statement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) => input.decision !== 'edit' || input.statement !== undefined,
    'Provide the wording you want.',
  );

export type ResolveProposal = z.infer<typeof resolveProposalSchema>;

/** What integration did, per requirement. Returned so the UI can explain it. */
export const integrationImpactSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    itemKey: z.string().max(16),
    outcome: z.enum(INTEGRATION_OUTCOMES),
    before: z.string().max(ANALYSIS_LIMITS.maxDescriptionLength),
    after: z.string().max(ANALYSIS_LIMITS.maxDescriptionLength).optional(),
    reason: z.string().max(ANALYSIS_LIMITS.maxExplanationLength),
    proposalReason: z.enum(PROPOSAL_REASONS).optional(),
  })
  .strict();

export type IntegrationImpact = z.infer<typeof integrationImpactSchema>;

export const integrationResultSchema = z
  .object({
    clarificationId: z.string().min(1).max(64),
    clarificationKey: z.string().max(16),
    answerVersion: z.number().int().positive(),
    status: clarificationStatusSchema,
    impacts: z.array(integrationImpactSchema).max(200),
    /** Findings the answer closed. */
    resolvedFindingIds: z.array(z.string().max(64)).max(100),
    failureReason: z.string().max(300).optional(),
  })
  .strict();

export type IntegrationResult = z.infer<typeof integrationResultSchema>;

/* ------------------------------------------------------------ helpers */

/**
 * A question that still stops approval.
 *
 * Unanswered, answered-but-unconfirmed, mid-integration, failed or awaiting
 * review all count: none of them means the baseline reflects the answer. Only
 * `INTEGRATED` and `DISMISSED` settle it.
 */
export function blocksBaselineApproval(clarification: Clarification): boolean {
  return (
    clarification.blocksApproval && !SETTLED_CLARIFICATION_STATUSES.includes(clarification.status)
  );
}

export function clarificationKey(sequence: number): string {
  return `Q-${String(sequence).padStart(3, '0')}`;
}

/** Blocking by default for a conflict or a gap that stops implementation. */
export function defaultBlocksApproval(
  category: ClarificationCategory,
  impact: ClarificationImpact,
): boolean {
  return impact === 'blocking' || category === 'conflict';
}
