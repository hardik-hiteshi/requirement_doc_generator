import { z } from 'zod';

import { ANALYSIS_LIMITS } from './analysis-limits';
import { missingDimensionSchema } from './findings.contract';

/**
 * A question worth a stakeholder's time.
 *
 * The pressure-release valve for everything the analysis found and cannot
 * settle: a gap, a contradiction, a word nobody defined. The alternative — a
 * model filling the gap with something plausible — produces a document that
 * reads as complete and is wrong in the places nobody will check.
 *
 * Three rules make this work:
 *
 * 1. **An answer is a fact, not a guess.** Answered clarifications become
 *    evidence, and the requirements they touch gain confidence accordingly.
 * 2. **Nothing becomes an assumption by itself.** Turning an unanswered
 *    question into "we assume X" is an explicit act with a person's name on it.
 * 3. **Blocking questions block.** A question the baseline genuinely depends on
 *    prevents approval until it is answered or explicitly dismissed.
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

export const CLARIFICATION_STATUSES = [
  'open',
  'answered',
  /** A person judged it not worth asking. Recorded with their reason. */
  'dismissed',
  /**
   * Answered, and the answer has been folded into the requirements it affects.
   *
   * Separate from `answered` because integration is a second step that can fail
   * or be deferred, and "we have the answer" is a different state from "the
   * requirements reflect it".
   */
  'integrated',
] as const;

export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];
export const clarificationStatusSchema = z.enum(CLARIFICATION_STATUSES);

export const CLARIFICATION_IMPACTS = ['blocking', 'important', 'nice_to_have'] as const;
export type ClarificationImpact = (typeof CLARIFICATION_IMPACTS)[number];
export const clarificationImpactSchema = z.enum(CLARIFICATION_IMPACTS);

export const clarificationAnswerSchema = z
  .object({
    text: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    answeredAt: z.iso.datetime(),
    /**
     * Whether the answer should become an assumption if it is not confirmed.
     *
     * Set by the person answering, never by the application. An answer given on
     * a colleague's behalf is an assumption; one from the client is a fact, and
     * only the person in the room knows which this is.
     */
    isAssumption: z.boolean(),
    integratedAt: z.iso.datetime().optional(),
    /** Requirements changed or created because of this answer. */
    affectedItemIds: z.array(z.string().max(64)).max(100).default([]),
  })
  .strict();

export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export const clarificationSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    /** Stable and human-facing: Q-001. */
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
    answer: clarificationAnswerSchema.optional(),
    dismissedReason: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    /**
     * Whether an unanswered state stops the baseline being approved.
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

export const answerClarificationSchema = z
  .object({
    text: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    /**
     * Whether this answer is an internal assumption rather than a client fact.
     *
     * Deliberately required rather than defaulted. The difference decides
     * whether the resulting requirement is stated as a requirement or recorded
     * as an assumption, and a default would make that choice for the user.
     */
    isAssumption: z.boolean(),
    /** Fold the answer into affected requirements now, using the model. */
    integrateNow: z.boolean().default(false),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AnswerClarification = z.infer<typeof answerClarificationSchema>;

export const dismissClarificationSchema = z
  .object({
    reason: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type DismissClarification = z.infer<typeof dismissClarificationSchema>;

/** A question that still stops approval. */
export function blocksBaselineApproval(clarification: Clarification): boolean {
  return clarification.blocksApproval && clarification.status === 'open';
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
