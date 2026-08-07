/**
 * Bounds on what an analysis run may produce or consume.
 *
 * Every one of these exists because a language model has no natural stopping
 * point. Asked to list requirements it will list them until something stops it,
 * and "something" has to be a number decided in advance rather than a memory
 * limit discovered in production.
 *
 * These are ceilings, not targets. Hitting one is a signal that the input needs
 * splitting, and the application says so rather than silently truncating.
 */
export const ANALYSIS_LIMITS = {
  /** Requirement items from one analysis run. */
  maxRequirementItems: 2_000,
  /** Items from a single task execution, before combination. */
  maxItemsPerTask: 300,
  maxDuplicateGroups: 500,
  maxConflicts: 300,
  maxFindings: 1_000,
  maxClarifications: 200,

  /** Field ceilings, so one pathological string cannot dominate a document. */
  maxTitleLength: 300,
  maxDescriptionLength: 4_000,
  maxExplanationLength: 2_000,
  maxExcerptLength: 1_000,

  /** Source references on one requirement item. */
  maxReferencesPerItem: 50,

  /**
   * Repair attempts after a schema failure.
   *
   * Two, and not more. A model that has produced invalid output twice against
   * the same schema is not one attempt away from getting it right — it is
   * telling you the schema is beyond it, and further attempts cost minutes of
   * local inference to reach the same answer.
   */
  maxRepairAttempts: 2,

  /**
   * Characters of evidence in one chunk.
   *
   * Deliberately in characters rather than tokens: the ratio varies by model and
   * tokeniser, the budget has to be computed before a provider is chosen, and a
   * conservative character budget is a defensible approximation. The provider
   * applies the real token limit as well.
   */
  defaultChunkCharacters: 12_000,
  minChunkCharacters: 2_000,
  maxChunkCharacters: 60_000,

  /** Chunks in one run. Beyond this the project needs splitting by a human. */
  maxChunks: 200,
} as const;

/**
 * A conservative characters-per-token ratio for budgeting.
 *
 * English prose runs about 4 characters per token on most tokenisers;
 * requirement documents contain identifiers, tables and punctuation that
 * tokenise worse. Three is deliberately pessimistic — over-estimating tokens
 * makes a chunk too small, which is slow. Under-estimating makes it overflow,
 * which fails.
 */
export const CHARACTERS_PER_TOKEN_ESTIMATE = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN_ESTIMATE);
}

/**
 * How much evidence fits in one request for a given model.
 *
 * The context has to hold the instructions, the evidence *and* the answer, so
 * the output reservation comes off the top. The remaining 80% leaves room for
 * the prompt itself and for the estimate above being wrong.
 */
export function evidenceBudgetCharacters(contextTokens: number, maxOutputTokens: number): number {
  const available = Math.max(0, contextTokens - maxOutputTokens);
  const usable = Math.floor(available * 0.8);

  return Math.max(
    ANALYSIS_LIMITS.minChunkCharacters,
    Math.min(ANALYSIS_LIMITS.maxChunkCharacters, usable * CHARACTERS_PER_TOKEN_ESTIMATE),
  );
}
