import { z } from 'zod';

import { ANALYSIS_LIMITS } from './analysis-limits';

/**
 * What the analysis noticed but must not act on alone.
 *
 * Duplicates, contradictions, vague wording and missing detail. Every one of
 * them is *surfaced*, never resolved automatically, and the reason is the same
 * in each case: acting would destroy information a person needs.
 *
 * - Merging two duplicates silently loses whichever wording the client
 *   preferred, and the fact that two documents said the same thing.
 * - Picking a winner between contradictory requirements makes a scope decision
 *   nobody was asked about — and the losing statement disappears with it.
 * - Rewriting vague language substitutes the model's guess for the client's
 *   intent, in a document the client will sign.
 * - Filling a gap with a plausible value turns a known unknown into an apparent
 *   fact, which is the most expensive kind of error this application can make.
 *
 * So each finding has a status, each status changes only by a human decision,
 * and the open ones are what block a baseline from being approved.
 */

export const FINDING_STATUSES = [
  'open',
  /** A person decided what to do, and did it. */
  'resolved',
  /** A person judged it not a problem. Recorded, with their note. */
  'dismissed',
  /** A person accepted it as a known risk. It stops blocking approval. */
  'accepted_risk',
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const findingStatusSchema = z.enum(FINDING_STATUSES);

export function isFindingOpen(status: FindingStatus): boolean {
  return status === 'open';
}

/** Every resolution carries who decided and why. A decision without a reason
 * is indistinguishable from a mis-click three months later. */
export const findingDecisionSchema = z
  .object({
    note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    decidedAt: z.iso.datetime(),
  })
  .strict();

export type FindingDecision = z.infer<typeof findingDecisionSchema>;

/* --------------------------------------------------------- duplicates */

export const DUPLICATE_KINDS = [
  /** The same sentence, character for character after normalisation. */
  'exact',
  /** Nearly the same wording. */
  'near',
  /** Different words, same requirement. Only a model can see these. */
  'restated',
] as const;

export type DuplicateKind = (typeof DUPLICATE_KINDS)[number];
export const duplicateKindSchema = z.enum(DUPLICATE_KINDS);

export const DUPLICATE_RESOLUTIONS = ['merge', 'keep_separate'] as const;
export type DuplicateResolution = (typeof DUPLICATE_RESOLUTIONS)[number];

export const duplicateGroupSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    kind: duplicateKindSchema,
    /** Two or more. A group of one is not a duplicate. */
    itemIds: z.array(z.string().min(1).max(64)).min(2).max(50),
    /**
     * Which item the analysis would keep — a *suggestion*, and nothing happens
     * until a person accepts it. Usually the one with the best evidence.
     */
    suggestedPrimaryId: z.string().min(1).max(64),
    /** 0–1, from deterministic text comparison, not from the model. */
    similarity: z.number().min(0).max(1),
    rationale: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    /** True when the items came from different chunks. */
    crossChunk: z.boolean(),
    /**
     * True when they came from different documents.
     *
     * The interesting case, and the one chunk-local analysis cannot find: the
     * same requirement stated in two files means two stakeholders wrote it, and
     * whether they meant the same thing is worth a person's attention.
     */
    crossSource: z.boolean(),
    status: findingStatusSchema,
    resolution: duplicateGroupResolutionSchema().optional(),
    createdAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
  })
  .strict();

function duplicateGroupResolutionSchema() {
  return z
    .object({
      action: z.enum(DUPLICATE_RESOLUTIONS),
      /** Required for a merge: which item survives. Chosen by a person. */
      primaryId: z.string().max(64).optional(),
      note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
      decidedAt: z.iso.datetime(),
    })
    .strict();
}

export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

export const resolveDuplicateSchema = z
  .object({
    action: z.enum(DUPLICATE_RESOLUTIONS),
    /** Required when merging. The other items become `superseded`, not deleted. */
    primaryId: z.string().min(1).max(64).optional(),
    note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) => input.action !== 'merge' || input.primaryId !== undefined,
    'Choose which requirement to keep.',
  );

export type ResolveDuplicate = z.infer<typeof resolveDuplicateSchema>;

/* ---------------------------------------------------------- conflicts */

export const CONFLICT_KINDS = [
  /** One statement asserts what another denies. */
  'contradiction',
  /** Both state a value for the same thing, and the values differ. */
  'incompatible_values',
  /** One includes what another excludes. */
  'scope',
  /** The same word used for two different things, or two words for one. */
  'terminology',
  /** One cannot be satisfied while the other is. */
  'mutually_exclusive',
] as const;

export type ConflictKind = (typeof CONFLICT_KINDS)[number];
export const conflictKindSchema = z.enum(CONFLICT_KINDS);

/**
 * Where a conflict stands.
 *
 * Wider than the generic finding statuses, because a conflict is the one
 * finding a *clarification* can settle. The extra states exist so that
 * "re-evaluated, still a contradiction" is distinguishable from "nobody has
 * looked at it yet" — a distinction that matters to a reviewer deciding what to
 * spend their attention on.
 *
 * Three of these block approval, and they block for the same reason: the
 * baseline contains a contradiction nobody has settled.
 */
export const CONFLICT_STATUSES = [
  /** Found, untouched. */
  'open',
  /**
   * Re-evaluated after a confirmed clarification and still a contradiction.
   *
   * The answer did not address it, or addressed only part of it and the rest
   * still cannot both be true.
   */
  'still_conflicting',
  /**
   * Settled by a confirmed clarification, under deterministic rules.
   *
   * Never reachable on a model's opinion alone — see
   * `CLARIFICATION_RESOLUTION_CONDITIONS`.
   */
  'resolved_by_clarification',
  /**
   * A clarification touched it but did not settle it cleanly.
   *
   * A person has to look. Blocks approval, because an unsettled contradiction
   * is unsettled however it got there.
   */
  'needs_review',
  /** A person decided: chose, rewrote, or agreed the two do not conflict. */
  'resolved',
  /** A person judged it not a conflict. */
  'dismissed',
  /** A person accepted it as a known risk. */
  'accepted_risk',
  /** Replaced by a re-evaluated version of the same conflict. */
  'superseded',
] as const;

export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];
export const conflictStatusSchema = z.enum(CONFLICT_STATUSES);

export const CONFLICT_STATUS_LABELS: Readonly<Record<ConflictStatus, string>> = {
  open: 'Unresolved',
  still_conflicting: 'Still a contradiction',
  resolved_by_clarification: 'Settled by a client answer',
  needs_review: 'Needs your review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  accepted_risk: 'Accepted as a risk',
  superseded: 'Replaced',
};

/** Conflict states that stop a baseline being approved. */
export const BLOCKING_CONFLICT_STATUSES: readonly ConflictStatus[] = [
  'open',
  'still_conflicting',
  'needs_review',
];

/**
 * Every condition that must hold before a conflict may be marked
 * `resolved_by_clarification` automatically.
 *
 * Listed as data because the list *is* the control. Each is checked by
 * application code against stored records; the model is consulted about one of
 * them and can only withhold agreement, never supply it.
 */
export const CLARIFICATION_RESOLUTION_CONDITIONS = [
  /** The answer has been confirmed as the client's, not merely typed. */
  'confirmed_answer',
  /** It is a fact from the client, not something the team is assuming. */
  'authoritative_not_assumption',
  /** The clarification is linked to at least one requirement in the conflict. */
  'linked_to_conflict',
  /** Every position in the conflict was actually updated by the answer. */
  'all_positions_addressed',
  /** Those updates are applied, not sitting as unaccepted proposals. */
  'updates_applied',
  /** The model agrees the answer resolves the contradiction. */
  'semantic_agreement',
] as const;

export type ClarificationResolutionCondition = (typeof CLARIFICATION_RESOLUTION_CONDITIONS)[number];

export const RESOLUTION_CONDITION_LABELS: Readonly<
  Record<ClarificationResolutionCondition, string>
> = {
  confirmed_answer: 'The answer was confirmed as the client’s',
  authoritative_not_assumption: 'It is a client fact, not an assumption',
  linked_to_conflict: 'The question is linked to a requirement in this conflict',
  all_positions_addressed: 'Every contradicting requirement was updated by the answer',
  updates_applied: 'Those updates are applied, not waiting for review',
  semantic_agreement: 'The answer addresses what the two statements disagreed about',
};

/**
 * How badly a conflict has to be dealt with.
 *
 * `blocking` prevents approval outright. That is not a judgement about
 * importance — it is that a baseline containing a contradiction is not a
 * specification, and signing one commits both parties to something impossible.
 */
export const CONFLICT_SEVERITIES = ['blocking', 'major', 'minor'] as const;
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];
export const conflictSeveritySchema = z.enum(CONFLICT_SEVERITIES);

export const CONFLICT_RESOLUTIONS = [
  /** One statement is correct; the other becomes `rejected`. */
  'choose',
  /** Neither is; a person writes the replacement. */
  'rewrite',
  /** Both stand — they turned out not to conflict. */
  'keep_both',
  /** Cannot be settled without the client. Raises a clarification. */
  'ask_client',
] as const;

export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

/**
 * One re-evaluation of a conflict, triggered by a confirmed clarification.
 *
 * Written whether or not the conflict changed. "We looked at this again after
 * Q-004 and it is still a contradiction" is exactly as much a fact worth
 * recording as a resolution, and an auditor needs both.
 */
export const conflictReevaluationSchema = z
  .object({
    clarificationId: z.string().min(1).max(64),
    clarificationKey: z.string().max(16),
    /** Which version of the answer. A later answer re-evaluates again. */
    answerVersion: z.number().int().positive(),
    /** The requirements the clarification changed, scoped to this conflict. */
    affectedItemIds: z.array(z.string().max(64)).max(50),
    previousStatus: conflictStatusSchema,
    resultingStatus: conflictStatusSchema,
    previousVersion: z.number().int().nonnegative(),
    resultingVersion: z.number().int().nonnegative(),
    /** Which conditions held. The list is the reason. */
    conditionsMet: z.array(z.enum(CLARIFICATION_RESOLUTION_CONDITIONS)).max(10),
    conditionsFailed: z.array(z.enum(CLARIFICATION_RESOLUTION_CONDITIONS)).max(10),
    /** Plain language, for a reviewer and an auditor. Never model output. */
    rationale: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    evaluatedAt: z.iso.datetime(),
  })
  .strict();

export type ConflictReevaluation = z.infer<typeof conflictReevaluationSchema>;

export const conflictSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    kind: conflictKindSchema,
    severity: conflictSeveritySchema,
    itemIds: z.array(z.string().min(1).max(64)).min(2).max(20),
    summary: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    /** What each side actually says, quoted, so a reviewer need not dig. */
    positions: z
      .array(
        z
          .object({
            itemId: z.string().min(1).max(64),
            statement: z.string().min(1).max(ANALYSIS_LIMITS.maxExcerptLength),
            sourceId: z.string().min(1).max(64),
            sourceName: z.string().max(300).optional(),
            citation: z.string().max(200).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(20),
    crossChunk: z.boolean(),
    /**
     * True when the conflicting statements came from different documents.
     *
     * The case the phase exists for. A requirement stated in file A and
     * contradicted in file B must surface as a conflict rather than whichever
     * chunk ran last quietly winning.
     */
    crossSource: z.boolean(),
    status: conflictStatusSchema,
    /**
     * Every re-evaluation this conflict has been through, oldest first.
     *
     * Append-only. An auditor asking "why is this no longer blocking?" reads
     * the trail; nothing here is ever rewritten.
     */
    reevaluations: z.array(conflictReevaluationSchema).max(50),
    resolution: z
      .object({
        action: z.enum(CONFLICT_RESOLUTIONS),
        /** For `choose`: which statement stands. Never picked automatically. */
        winningItemId: z.string().max(64).optional(),
        /** For `rewrite`: the replacement text a person wrote. */
        replacementStatement: z.string().max(ANALYSIS_LIMITS.maxDescriptionLength).optional(),
        /** For `ask_client`: the clarification this raised. */
        clarificationId: z.string().max(64).optional(),
        note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
        decidedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
    createdAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type Conflict = z.infer<typeof conflictSchema>;

export const resolveConflictSchema = z
  .object({
    action: z.enum(CONFLICT_RESOLUTIONS),
    winningItemId: z.string().min(1).max(64).optional(),
    replacementStatement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength).optional(),
    note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) => input.action !== 'choose' || input.winningItemId !== undefined,
    'Choose which requirement stands.',
  )
  .refine(
    (input) => input.action !== 'rewrite' || input.replacementStatement !== undefined,
    'Write the replacement statement.',
  );

export type ResolveConflict = z.infer<typeof resolveConflictSchema>;

/* -------------------------------------------------- ambiguity and gaps */

export const AMBIGUITY_KINDS = [
  /** "fast", "user-friendly", "modern" — no test can settle it. */
  'vague_term',
  /** "and/or", a pronoun with two possible referents. */
  'ambiguous_reference',
  /** "should", "may", "if possible" — is it required or not? */
  'unclear_obligation',
  /** A number with no unit, or a unit with no number. */
  'unquantified',
  /** Two requirements in one sentence. */
  'compound_statement',
  /** An undefined term the document treats as understood. */
  'undefined_term',
] as const;

export type AmbiguityKind = (typeof AMBIGUITY_KINDS)[number];
export const ambiguityKindSchema = z.enum(AMBIGUITY_KINDS);

export const ambiguityFindingSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    itemId: z.string().min(1).max(64),
    kind: ambiguityKindSchema,
    /** The exact words that are ambiguous, quoted from the requirement. */
    phrase: z.string().min(1).max(ANALYSIS_LIMITS.maxExcerptLength),
    why: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    /**
     * What a clearer version might say.
     *
     * A suggestion shown to a reviewer, never applied. Rewriting a client's
     * requirement to the model's guess is exactly the failure this finding
     * exists to prevent.
     */
    suggestion: z.string().max(ANALYSIS_LIMITS.maxDescriptionLength).optional(),
    status: findingStatusSchema,
    decision: findingDecisionSchema.optional(),
    createdAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type AmbiguityFinding = z.infer<typeof ambiguityFindingSchema>;

/**
 * The dimensions a requirement can be missing.
 *
 * A closed list rather than free text, so "what is usually missing from this
 * project's requirements" is a question the data can answer.
 */
export const MISSING_DIMENSIONS = [
  'acceptance_criteria',
  'actor',
  'data_fields',
  'validation_rules',
  'error_handling',
  'volume_or_scale',
  'performance_target',
  'security_expectation',
  'integration_detail',
  'timing_or_frequency',
  'permissions',
  'reporting_output',
] as const;

export type MissingDimension = (typeof MISSING_DIMENSIONS)[number];
export const missingDimensionSchema = z.enum(MISSING_DIMENSIONS);

export const MISSING_DIMENSION_LABELS: Readonly<Record<MissingDimension, string>> = {
  acceptance_criteria: 'Acceptance criteria',
  actor: 'Who does this',
  data_fields: 'Data fields',
  validation_rules: 'Validation rules',
  error_handling: 'What happens when it fails',
  volume_or_scale: 'Volume or scale',
  performance_target: 'Performance target',
  security_expectation: 'Security expectation',
  integration_detail: 'Integration detail',
  timing_or_frequency: 'Timing or frequency',
  permissions: 'Permissions',
  reporting_output: 'Reporting or output',
};

export const missingInfoFindingSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    /** Absent when the gap is about the project rather than one requirement. */
    itemId: z.string().max(64).optional(),
    dimension: missingDimensionSchema,
    why: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    /**
     * Whether this gap prevents the requirement from being implementable.
     *
     * A missing acceptance criterion usually does. A missing reporting format
     * usually does not. Only the blocking ones stop a baseline being approved.
     */
    blocksImplementation: z.boolean(),
    status: findingStatusSchema,
    decision: findingDecisionSchema.optional(),
    createdAt: z.iso.datetime(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type MissingInfoFinding = z.infer<typeof missingInfoFindingSchema>;

export const resolveFindingSchema = z
  .object({
    status: z.enum(['resolved', 'dismissed', 'accepted_risk']),
    note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ResolveFinding = z.infer<typeof resolveFindingSchema>;

/**
 * A conflict that stops approval.
 *
 * Blocking severity and an unsettled status. `still_conflicting` and
 * `needs_review` count: a contradiction that has been looked at and not settled
 * is no less of a contradiction than one nobody has read.
 */
export function isBlockingConflict(conflict: Pick<Conflict, 'severity' | 'status'>): boolean {
  return conflict.severity === 'blocking' && BLOCKING_CONFLICT_STATUSES.includes(conflict.status);
}

/**
 * An immutable snapshot of a conflict, written before every change.
 *
 * The positions are copied in full rather than referenced, because the whole
 * point is to answer "what was conflicting before the clarification?" — and a
 * reference to a requirement that has since been rewritten cannot answer it.
 */
export const conflictVersionSchema = z
  .object({
    conflictId: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    version: z.number().int().nonnegative(),
    status: conflictStatusSchema,
    severity: conflictSeveritySchema,
    kind: conflictKindSchema,
    summary: z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength),
    itemIds: z.array(z.string().max(64)).max(20),
    positions: z
      .array(
        z
          .object({
            itemId: z.string().min(1).max(64),
            statement: z.string().min(1).max(ANALYSIS_LIMITS.maxExcerptLength),
            sourceId: z.string().min(1).max(64),
            sourceName: z.string().max(300).optional(),
            citation: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(20),
    /** What caused this snapshot to be taken. */
    changedBy: z.enum(['analysis', 'user_decision', 'clarification_reevaluation']),
    clarificationKey: z.string().max(16).optional(),
    rationale: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type ConflictVersion = z.infer<typeof conflictVersionSchema>;
