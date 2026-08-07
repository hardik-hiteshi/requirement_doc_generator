import { z } from 'zod';

/**
 * The versioned AI tasks that make up requirement analysis.
 *
 * Eleven separate tasks rather than one prompt, because a single prompt that
 * normalises, classifies, deduplicates, finds conflicts *and* writes
 * clarification questions has no failure mode short of "the whole thing was
 * wrong". Separate tasks mean a schema per output, a retry per stage, and a
 * failure that names which step broke.
 *
 * A task identifier is a contract in its own right: it appears in audit records
 * and in every analysis run, so renaming one is a breaking change and adding a
 * new one is not.
 */
export const AI_TASK_IDS = [
  /** Reviewed source blocks into normalised, self-contained statements. */
  'requirement.normalize',
  /** Each statement into one of the requirement categories. */
  'requirement.classify',
  /** Structured requirement items, with their source references. */
  'requirement.extract',
  /** Exact, near and restated duplicates, grouped. */
  'requirement.duplicates',
  /** Contradictions between requirements, with severity. */
  'requirement.conflicts',
  /** Language too vague to implement from. */
  'requirement.ambiguity',
  /** Dimensions a requirement needs but does not state. */
  'requirement.missing',
  /** Questions worth a stakeholder's time. */
  'clarification.generate',
  /** A confirmed answer folded back into the affected requirements. */
  'clarification.integrate',
  /** The assembled baseline, checked for internal consistency. */
  'baseline.validate',
  /** Terminology and meaning consistent across sources. */
  'baseline.crossSource',
] as const;

export type AiTaskId = (typeof AI_TASK_IDS)[number];

export const aiTaskIdSchema = z.enum(AI_TASK_IDS);

/** Human-readable stage labels. Shown while an analysis run is working. */
export const AI_TASK_LABELS: Readonly<Record<AiTaskId, string>> = {
  'requirement.normalize': 'Normalising requirement statements',
  'requirement.classify': 'Classifying requirements',
  'requirement.extract': 'Extracting structured requirements',
  'requirement.duplicates': 'Looking for duplicates',
  'requirement.conflicts': 'Looking for contradictions',
  'requirement.ambiguity': 'Looking for ambiguous language',
  'requirement.missing': 'Looking for missing detail',
  'clarification.generate': 'Preparing clarification questions',
  'clarification.integrate': 'Applying clarification answers',
  'baseline.validate': 'Validating the baseline',
  'baseline.crossSource': 'Checking consistency across sources',
};

/* ------------------------------------------------------------- failures */

/**
 * Why an AI task did not produce a usable result.
 *
 * Split by *what a caller should do about it*, not by where it came from. The
 * retryable set is deliberately small: retrying a context overflow or a schema
 * failure with the same input produces the same answer, more slowly.
 */
export const AI_FAILURE_REASONS = [
  'provider_unavailable',
  'model_unavailable',
  'model_loading',
  'timeout',
  'context_overflow',
  'invalid_json',
  'schema_invalid',
  'partial_response',
  'duplicate_identifiers',
  'missing_source_reference',
  'hallucinated_source_reference',
  'unsupported_category',
  'repair_exhausted',
  'budget_exceeded',
  'content_refused',
  'cancelled',
] as const;

export type AiFailureReason = (typeof AI_FAILURE_REASONS)[number];

/**
 * Failures a retry could plausibly clear.
 *
 * `model_loading` is here because a cold self-hosted model genuinely does
 * become available a few seconds later — a failure mode that does not exist
 * with a hosted API, and one worth handling rather than surfacing.
 */
export const RETRYABLE_AI_FAILURES: readonly AiFailureReason[] = [
  'provider_unavailable',
  'model_loading',
  'timeout',
];

export function isRetryableAiFailure(reason: AiFailureReason): boolean {
  return RETRYABLE_AI_FAILURES.includes(reason);
}

/** Safe, user-facing text. Technical detail stays in the structured log. */
export const AI_FAILURE_MESSAGES: Readonly<Record<AiFailureReason, string>> = {
  provider_unavailable:
    'The analysis service is not responding. Check that your inference server is running, then retry.',
  model_unavailable:
    'The configured model is not available on the inference server. Pull it, or choose a model that is installed.',
  model_loading:
    'The model is still loading. This usually clears in a few seconds — retry shortly.',
  timeout: 'Analysis took longer than the configured limit and was stopped.',
  context_overflow:
    'This project has more content than the configured model can read at once. Split it, or configure a model with a larger context.',
  invalid_json: 'The model did not return usable structured output.',
  schema_invalid: 'The model returned output that does not match what this step expects.',
  partial_response: 'The model stopped part-way through its answer.',
  duplicate_identifiers: 'The model reused an identifier, so its output could not be trusted.',
  missing_source_reference:
    'The model produced a requirement with no source, which cannot be traced back to your documents.',
  hallucinated_source_reference:
    'The model cited a source that does not exist in this project. The result was discarded.',
  unsupported_category: 'The model used a requirement category this application does not define.',
  repair_exhausted:
    'The model could not produce valid output after several attempts. Try again, or use a larger model.',
  budget_exceeded: 'This step would exceed the configured size limit.',
  content_refused: 'The model declined to process this content.',
  cancelled: 'Analysis was cancelled.',
};

/* --------------------------------------------------------------- usage */

/**
 * What a task consumed.
 *
 * **No monetary cost.** Inference runs on the operator's own hardware, so there
 * is no vendor invoice to report, and displaying an invented per-token price
 * would be fiction. Duration and sizes are the real, measurable facts.
 */
export const aiUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** Reused from a prefix cache, where the server implements one. */
    cachedInputTokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type AiUsage = z.infer<typeof aiUsageSchema>;

/** One task execution, as recorded against an analysis run. */
export const aiTaskExecutionSchema = z
  .object({
    taskId: aiTaskIdSchema,
    promptVersion: z.string().min(1).max(20),
    provider: z.string().min(1).max(60),
    model: z.string().min(1).max(120),
    modelProfileId: z.string().min(1).max(80),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    succeeded: z.boolean(),
    failureReason: z.enum(AI_FAILURE_REASONS).optional(),
    /** How many repair attempts were needed before the output validated. */
    repairAttempts: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    usage: aiUsageSchema.optional(),
    /** Which chunk this execution covered, for a chunked task. */
    chunkId: z.string().max(80).optional(),
  })
  .strict();

export type AiTaskExecution = z.infer<typeof aiTaskExecutionSchema>;
