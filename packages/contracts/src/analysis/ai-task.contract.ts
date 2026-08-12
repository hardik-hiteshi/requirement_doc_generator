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
  /**
   * Whether a confirmed answer settles a contradiction.
   *
   * Advisory only. The application decides; this can withhold agreement and
   * nothing else — see `conflict-reevaluation.ts`.
   */
  'conflict.reevaluate',
  /** The assembled baseline, checked for internal consistency. */
  'baseline.validate',
  /** Terminology and meaning consistent across sources. */
  'baseline.crossSource',
  /**
   * Technologies for the categories a stack has not decided.
   *
   * Phase 5. Picks from the reviewed catalogue and explains why for this
   * project; it supplies no commercial fact and no authority — see
   * `stack/recommendation-schema.ts`.
   */
  'stack.recommend',
  /**
   * Complexity and drivers for one requirement.
   *
   * Phase 6. Proposes *inputs* to the estimation arithmetic — a task category,
   * a complexity, the drivers behind it — and never an hours figure. The
   * application does the sums; see `estimation/estimation-engine.ts`.
   */
  'estimation.assess',
  /**
   * Which sections of a document the evidence can actually support.
   *
   * Phase 7. Plans a document against the approved baseline: what each section
   * has evidence for, and which requirements belong to it. It selects and
   * groups; it writes no prose and invents no section — the template is fixed.
   */
  'document.plan',
  /**
   * The prose for one section of a document.
   *
   * Phase 7. Writes into a section the application chose, from evidence the
   * application selected, citing only requirement ids it was given. Used for
   * first generation and for regeneration alike — a rewrite is the same task
   * with a correction in the evidence channel.
   */
  'document.section',
  /**
   * Requirements grouped into implementable features.
   *
   * Phase 7. Returns module, submodule, screen and description per feature, and
   * the requirements behind it. Its schema has nowhere to put an hours figure:
   * effort comes from the approved estimate — see `feature-listing.contract.ts`.
   */
  'document.features',
  /**
   * A finished document, read for statements the evidence does not support.
   *
   * Phase 7. Advisory and additive: it can raise findings a checker cannot see,
   * and it can never clear or downgrade one. Deterministic checks decide whether
   * a document may be approved.
   */
  'document.validate',
  /**
   * Acceptance conditions for approved features.
   *
   * Phase 8. Returns wording only: the observable outcome, and optionally the
   * precondition and action. Its schema has nowhere to put a threshold, a feature
   * it was not given, or an effort figure — see `acceptance-criteria.contract.ts`.
   */
  'acceptance_criteria.generate',
  /** One acceptance criterion, rewritten. Phase 8. */
  'acceptance_criteria.regenerate',
  /**
   * Things the plan appears to be resting on.
   *
   * Phase 8, and the most carefully bounded task in the application. It returns
   * **candidates**: a statement, a category, why it looked like an assumption.
   * There is no field for status, provenance, owner or confirmation, so nothing it
   * returns can become an authoritative assumption without a person — see
   * `assumptions.contract.ts`.
   */
  'assumptions.suggest',
  /** One section of a statement of work. Phase 8. */
  'sow.section.generate',
  /**
   * Task wording and decomposition for the work breakdown.
   *
   * Phase 9. Names and groups work; it cannot state an hours figure, a day, a date
   * or a critical-path flag, because `wbsTaskDraftSchema` has nowhere to put one.
   * Where it proposes splitting a unit of work, it gives relative sizes and the
   * application divides the approved hours so the parts still sum to the whole.
   */
  'wbs.tasks.generate',
  /** One work package, reworded. Phase 9. */
  'wbs.tasks.regenerate',
  /**
   * Client dependencies the approved scope implies.
   *
   * Phase 9. Returns what appears to be needed and why. No owner, no due date, no
   * status, no priority — and nowhere to put a credential value. Every row it
   * suggests still has to be grounded in something approved before it is stored.
   */
  'client_dependencies.suggest',
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
  'conflict.reevaluate': 'Re-checking affected contradictions',
  'baseline.validate': 'Validating the baseline',
  'baseline.crossSource': 'Checking consistency across sources',
  'stack.recommend': 'Suggesting technologies',
  'estimation.assess': 'Assessing how hard each thing is',
  'document.plan': 'Planning the document',
  'document.section': 'Writing a section',
  'document.features': 'Grouping requirements into features',
  'acceptance_criteria.generate': 'Writing acceptance conditions',
  'acceptance_criteria.regenerate': 'Rewriting an acceptance condition',
  'assumptions.suggest': 'Looking for what the plan is resting on',
  'sow.section.generate': 'Writing a section of the statement of work',
  'wbs.tasks.generate': 'Naming the work in the breakdown',
  'wbs.tasks.regenerate': 'Rewording a work package',
  'client_dependencies.suggest': 'Looking for what we need from the client',
  'document.validate': 'Reading the document back',
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
  /**
   * The model returned content this application will not store.
   *
   * Distinct from `content_refused`, which is the model declining, and from
   * `schema_invalid`, which is a shape problem. This is well-formed output that
   * breaks a rule about substance: a credential value in a client dependency sheet,
   * or a request too vague for anybody to act on. Phase 9.
   */
  'disallowed_content',
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
  disallowed_content:
    'The model returned something this application will not record — a credential value, or a request too vague to act on. The result was discarded.',
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
