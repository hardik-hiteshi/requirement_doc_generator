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
    status: findingStatusSchema,
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

/** A conflict that stops approval: blocking severity, still open. */
export function isBlockingConflict(conflict: Conflict): boolean {
  return conflict.severity === 'blocking' && conflict.status === 'open';
}
