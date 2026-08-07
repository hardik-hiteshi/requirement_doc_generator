import {
  ANALYSIS_LIMITS,
  type AmbiguityKind,
  type ClarificationCategory,
  type ClarificationImpact,
  type ConflictKind,
  type ConflictSeverity,
  type DuplicateKind,
  type MissingDimension,
  type RequirementCategory,
  type RequirementPriority,
} from '@wdrg/contracts';
import { z } from 'zod';

/**
 * What each AI task is allowed to return, and what it means here.
 *
 * Two vocabularies meet in this file and they are kept apart on purpose. The
 * **model's** vocabulary is what the prompts ask for: shouty constants, a flat
 * shape, free-text kinds. The **domain's** vocabulary is the contracts package.
 * Translating between them here means a prompt can be reworded, or a model
 * swapped, without the rest of the application learning a new spelling of
 * "functional requirement".
 *
 * Every schema is `.strict()`. Unknown keys are rejected rather than stripped:
 * a model inventing a field is telling you it misunderstood the task, and
 * silently discarding the evidence of that is how a misunderstanding reaches a
 * baseline.
 *
 * Every mapping is **total and closed**. A value the model made up does not
 * become a plausible default — it fails validation, which is a repairable
 * error, rather than becoming `functional` and disappearing.
 */

const id = z.string().min(1).max(64);
const shortText = z.string().min(1).max(ANALYSIS_LIMITS.maxTitleLength);
const longText = z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength);
const explanation = z.string().min(1).max(ANALYSIS_LIMITS.maxExplanationLength);
const excerpt = z.string().min(1).max(ANALYSIS_LIMITS.maxExcerptLength);
const blockIds = z.array(z.string().min(1).max(64)).min(1).max(50);

/**
 * A confidence the model reports about its own output.
 *
 * Accepted, stored, labelled — and never used to decide anything. See
 * `evidence-confidence.ts` for the score that does.
 */
const modelConfidence = z.number().min(0).max(1);

/* ------------------------------------------------------- normalisation */

export const normalizeOutputSchema = z
  .object({
    statements: z
      .array(
        z
          .object({
            id,
            text: longText,
            blockIds,
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxItemsPerTask),
  })
  .strict();

export type NormalizeOutput = z.infer<typeof normalizeOutputSchema>;

/* -------------------------------------------------------- classification */

/**
 * The model's category vocabulary.
 *
 * Uppercase and explicit because a small model follows a closed list of shouty
 * constants far more reliably than it follows a sentence describing them.
 */
export const MODEL_CATEGORIES = {
  FUNCTIONAL_REQUIREMENT: 'functional',
  NON_FUNCTIONAL_REQUIREMENT: 'non_functional',
  BUSINESS_RULE: 'business_rule',
  CONSTRAINT: 'constraint',
  INTEGRATION: 'integration',
  DATA_REQUIREMENT: 'data',
  USER_ROLE: 'user_role',
  OUT_OF_SCOPE: 'out_of_scope',
  /**
   * Deliberately absent: ASSUMPTION.
   *
   * The model cannot produce one. An assumption is created only by a person
   * confirming a clarification answer or typing one, because an assumption
   * generated from a gap is a guess wearing the costume of a fact.
   */
} as const satisfies Record<string, RequirementCategory>;

export const modelCategorySchema = z.enum(Object.keys(MODEL_CATEGORIES) as [string, ...string[]]);

export function toCategory(value: string): RequirementCategory {
  const mapped = (MODEL_CATEGORIES as Record<string, RequirementCategory>)[value];

  if (!mapped) {
    // Unreachable through validated output; a guard rather than a fallback,
    // because a silent default here would mis-file a requirement forever.
    throw new Error(`Unmapped model category: ${value}`);
  }

  return mapped;
}

export const MODEL_NFR_DIMENSIONS = [
  'PERFORMANCE',
  'SCALABILITY',
  'AVAILABILITY',
  'SECURITY',
  'PRIVACY',
  'USABILITY',
  'ACCESSIBILITY',
  'MAINTAINABILITY',
  'COMPATIBILITY',
  'COMPLIANCE',
  'OBSERVABILITY',
] as const;

export const classifyOutputSchema = z
  .object({
    classifications: z
      .array(
        z
          .object({
            statementId: id,
            category: modelCategorySchema,
            /** Required when the category is non-functional. */
            nfrDimension: z.enum(MODEL_NFR_DIMENSIONS).nullish(),
            confidence: modelConfidence,
            /** Why this category. Shown to a reviewer beside the choice. */
            reason: explanation.nullish(),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxItemsPerTask),
  })
  .strict();

export type ClassifyOutput = z.infer<typeof classifyOutputSchema>;

/* ------------------------------------------------------------ extraction */

export const MODEL_PRIORITIES = {
  MUST: 'must',
  SHOULD: 'should',
  COULD: 'could',
  WONT: 'wont',
  NOT_STATED: 'unspecified',
} as const satisfies Record<string, RequirementPriority>;

export const extractOutputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id,
            statementIds: z.array(id).min(1).max(20),
            category: modelCategorySchema,
            nfrDimension: z.enum(MODEL_NFR_DIMENSIONS).nullish(),
            title: shortText,
            description: longText,
            priority: z.enum(Object.keys(MODEL_PRIORITIES) as [string, ...string[]]).nullish(),
            /**
             * The evidence, quoted.
             *
             * Required, non-empty, and checked against the real block text by
             * the application afterwards. A model that cannot quote the source
             * has not extracted a requirement from it.
             */
            evidence: z
              .array(
                z
                  .object({
                    blockId: z.string().min(1).max(64),
                    excerpt,
                  })
                  .strict(),
              )
              .min(1)
              .max(ANALYSIS_LIMITS.maxReferencesPerItem),
            confidence: modelConfidence,
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxItemsPerTask),
    /**
     * Blocks the model read and judged to state no requirement.
     *
     * Not optional, and not a formality. Without it, coverage would be "what we
     * found" over "what we read", which silently rewards a model that ignores
     * half a document. A block claimed to hold no requirement must come with
     * the reason it holds none.
     */
    nonRequirementBlocks: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(64),
            reason: explanation,
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxItemsPerTask),
  })
  .strict();

export type ExtractOutput = z.infer<typeof extractOutputSchema>;

/* ------------------------------------------------------------ duplicates */

export const MODEL_DUPLICATE_KINDS = {
  IDENTICAL: 'exact',
  RESTATED: 'restated',
  NEAR: 'near',
} as const satisfies Record<string, DuplicateKind>;

export const duplicatesOutputSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            id,
            itemIds: z.array(id).min(2).max(50),
            kind: z.enum(Object.keys(MODEL_DUPLICATE_KINDS) as [string, ...string[]]),
            explanation,
            /**
             * Which item the model would keep.
             *
             * A suggestion. Nothing merges until a person says so, and the
             * field is named to make that obvious at every call site.
             */
            suggestedPrimaryId: id,
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxDuplicateGroups),
  })
  .strict();

export type DuplicatesOutput = z.infer<typeof duplicatesOutputSchema>;

/* ------------------------------------------------------------- conflicts */

export const MODEL_CONFLICT_KINDS = {
  CONTRADICTION: 'contradiction',
  INCOMPATIBLE_VALUES: 'incompatible_values',
  SCOPE: 'scope',
  TERMINOLOGY: 'terminology',
  MUTUALLY_EXCLUSIVE: 'mutually_exclusive',
} as const satisfies Record<string, ConflictKind>;

export const MODEL_SEVERITIES = {
  CRITICAL: 'blocking',
  MAJOR: 'major',
  MINOR: 'minor',
} as const satisfies Record<string, ConflictSeverity>;

export const conflictsOutputSchema = z
  .object({
    conflicts: z
      .array(
        z
          .object({
            id,
            kind: z.enum(Object.keys(MODEL_CONFLICT_KINDS) as [string, ...string[]]),
            severity: z.enum(Object.keys(MODEL_SEVERITIES) as [string, ...string[]]),
            summary: explanation,
            /**
             * Both sides, quoted.
             *
             * Two or more, always. A conflict with one position is a complaint,
             * and the shape refuses to express one — which is also how "do not
             * choose a winner" becomes structural rather than hoped for.
             */
            positions: z
              .array(
                z
                  .object({
                    itemId: id,
                    statement: excerpt,
                  })
                  .strict(),
              )
              .min(2)
              .max(20),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxConflicts),
  })
  .strict();

export type ConflictsOutput = z.infer<typeof conflictsOutputSchema>;

/* ------------------------------------------------------------ ambiguity */

export const MODEL_AMBIGUITY_KINDS = {
  VAGUE_TERM: 'vague_term',
  AMBIGUOUS_REFERENCE: 'ambiguous_reference',
  UNCLEAR_OBLIGATION: 'unclear_obligation',
  UNQUANTIFIED: 'unquantified',
  COMPOUND_STATEMENT: 'compound_statement',
  UNDEFINED_TERM: 'undefined_term',
} as const satisfies Record<string, AmbiguityKind>;

export const ambiguityOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            id,
            itemId: id,
            kind: z.enum(Object.keys(MODEL_AMBIGUITY_KINDS) as [string, ...string[]]),
            phrase: excerpt,
            whyNotImplementable: explanation,
            /** Optional, and never applied. A reviewer decides. */
            suggestion: longText.nullish(),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxFindings),
  })
  .strict();

export type AmbiguityOutput = z.infer<typeof ambiguityOutputSchema>;

/* --------------------------------------------------------------- gaps */

export const MODEL_MISSING_DIMENSIONS = {
  ACCEPTANCE_CRITERIA: 'acceptance_criteria',
  ACTOR: 'actor',
  DATA_FIELDS: 'data_fields',
  VALIDATION_RULES: 'validation_rules',
  ERROR_HANDLING: 'error_handling',
  VOLUME_OR_SCALE: 'volume_or_scale',
  PERFORMANCE_TARGET: 'performance_target',
  SECURITY_EXPECTATION: 'security_expectation',
  INTEGRATION_DETAIL: 'integration_detail',
  TIMING_OR_FREQUENCY: 'timing_or_frequency',
  PERMISSIONS: 'permissions',
  REPORTING_OUTPUT: 'reporting_output',
} as const satisfies Record<string, MissingDimension>;

export const missingOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            id,
            itemId: id.nullish(),
            dimension: z.enum(Object.keys(MODEL_MISSING_DIMENSIONS) as [string, ...string[]]),
            whyItMatters: explanation,
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxFindings),
  })
  .strict();

export type MissingOutput = z.infer<typeof missingOutputSchema>;

/* ----------------------------------------------------------- questions */

export const MODEL_QUESTION_CATEGORIES = {
  MISSING_DETAIL: 'missing_detail',
  CONFLICT: 'conflict',
  AMBIGUITY: 'ambiguity',
  TERMINOLOGY: 'terminology',
  SCOPE: 'scope',
  ACCEPTANCE: 'acceptance',
} as const satisfies Record<string, ClarificationCategory>;

export const MODEL_IMPACTS = {
  BLOCKING: 'blocking',
  IMPORTANT: 'important',
  NICE_TO_HAVE: 'nice_to_have',
} as const satisfies Record<string, ClarificationImpact>;

export const clarificationOutputSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            id,
            question: longText,
            reason: explanation,
            category: z.enum(Object.keys(MODEL_QUESTION_CATEGORIES) as [string, ...string[]]),
            impact: z.enum(Object.keys(MODEL_IMPACTS) as [string, ...string[]]),
            itemIds: z.array(id).max(50),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxClarifications),
  })
  .strict();

export type ClarificationOutput = z.infer<typeof clarificationOutputSchema>;

export const integrateOutputSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            itemId: id,
            /** The rewritten statement. Only what the answer changes. */
            description: longText,
            resolvedFindingIds: z.array(id).max(50),
          })
          .strict(),
      )
      .max(100),
    /**
     * Requirements the answer creates that did not exist.
     *
     * Marked as coming from a clarification, so their origin is visible in the
     * baseline rather than blending in with what the documents said.
     */
    newRequirements: z
      .array(
        z
          .object({
            id,
            title: shortText,
            description: longText,
            category: modelCategorySchema,
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type IntegrateOutput = z.infer<typeof integrateOutputSchema>;

/* ------------------------------------------------ conflict re-evaluation */

/**
 * The model's opinion on whether an answer settles a contradiction.
 *
 * Advisory, and deliberately narrow: a boolean and a sentence. There is no
 * confidence field, because a confidence would invite somebody to threshold it
 * — and this opinion is a veto, not a vote. The application's deterministic
 * rules decide; a `false` here can stop a resolution and a `true` can never
 * cause one.
 */
export const conflictReevaluationOutputSchema = z
  .object({
    evaluations: z
      .array(
        z
          .object({
            conflictId: id,
            settled: z.boolean(),
            reason: explanation,
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxConflicts),
  })
  .strict();

export type ConflictReevaluationOutput = z.infer<typeof conflictReevaluationOutputSchema>;

/* --------------------------------------------------------- validation */

export const MODEL_VALIDATION_KINDS = {
  TERMINOLOGY: 'terminology',
  UNDEFINED_REFERENCE: 'undefined_reference',
  SCOPE_DISAGREEMENT: 'scope_disagreement',
  CONTRADICTION: 'contradiction',
} as const;

export const baselineValidationOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            id,
            itemIds: z.array(id).min(1).max(20),
            kind: z.enum(Object.keys(MODEL_VALIDATION_KINDS) as [string, ...string[]]),
            explanation,
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxFindings),
  })
  .strict();

export type BaselineValidationOutput = z.infer<typeof baselineValidationOutputSchema>;

export const crossSourceOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            id,
            term: shortText,
            /** How each document uses it. Two or more, or it is not a clash. */
            usages: z
              .array(
                z
                  .object({
                    sourceId: z.string().min(1).max(64),
                    meaning: explanation,
                  })
                  .strict(),
              )
              .min(2)
              .max(20),
            itemIds: z.array(id).max(50),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxFindings),
  })
  .strict();

export type CrossSourceOutput = z.infer<typeof crossSourceOutputSchema>;

/* -------------------------------------------------------------- mapping */

/** Looks a model constant up in a closed map, failing loudly if it is absent. */
export function mapModelValue<T>(map: Record<string, T>, value: string, kind: string): T {
  const mapped = map[value];

  if (mapped === undefined) {
    throw new Error(`Unmapped model ${kind}: ${value}`);
  }

  return mapped;
}
