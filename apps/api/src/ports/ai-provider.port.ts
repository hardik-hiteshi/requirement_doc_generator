/**
 * Outbound boundary for AI model calls.
 *
 * First adapter: Phase 4 (Anthropic Claude via the official SDK).
 *
 * The application never sends a free-form prompt and hopes for the best. Every
 * call names a versioned task, supplies evidence separately from instructions,
 * and declares the JSON schema the response must satisfy. That is what makes
 * responses validatable, prompts auditable, and providers replaceable.
 */

/** Identifies a versioned prompt in the registry. */
export interface PromptReference {
  /** Task id, e.g. `requirement.normalization`. */
  readonly taskId: string;
  /** Prompt version. Logged with every call so output can be attributed. */
  readonly version: string;
}

/**
 * Uploaded content and extracted text are untrusted. They are passed as evidence
 * — never concatenated into the system prompt — so instructions embedded in a
 * client's document cannot override application rules.
 */
export interface EvidenceBlock {
  /** Traceability id of the source this text came from. */
  readonly sourceId: string;
  readonly label: string;
  readonly content: string;
}

export interface AiTaskRequest<TSchema = unknown> {
  readonly prompt: PromptReference;
  /** Trusted, application-authored instruction text. */
  readonly instructions: string;
  /** Untrusted material, quoted as evidence. */
  readonly evidence: readonly EvidenceBlock[];
  /** JSON Schema the response must satisfy. */
  readonly responseSchema: TSchema;
  /** Correlation id, propagated into usage records and audit events. */
  readonly correlationId: string;
  /** Hard ceiling for this call, enforced before the request is sent. */
  readonly maxOutputTokens?: number;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Estimated cost in the configured billing currency's minor units. */
  readonly estimatedCostMinorUnits: number;
}

export interface AiTaskResult<TOutput> {
  /** Response parsed and validated against `responseSchema`. */
  readonly output: TOutput;
  readonly usage: AiUsage;
  /** Provider and model that produced the output, for audit. */
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  /** How many repair attempts were needed before the response validated. */
  readonly repairAttempts: number;
}

/** Failure modes a caller must handle. Adapters map vendor errors onto these. */
export type AiFailureReason =
  | 'invalid_response' // Response never satisfied the schema, after repairs.
  | 'context_overflow' // Input exceeded the model's context window.
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'budget_exceeded' // Would breach the configured cost or token limit.
  | 'content_refused'; // Provider declined the request.

export class AiProviderError extends Error {
  constructor(
    public readonly reason: AiFailureReason,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiProviderError';
  }
}

export interface AiProviderPort {
  /**
   * Executes a versioned AI task and returns a schema-validated result.
   *
   * @throws {AiProviderError} for every failure mode above. Implementations must
   * never return a partially valid or unvalidated response.
   */
  runTask<TOutput>(request: AiTaskRequest): Promise<AiTaskResult<TOutput>>;

  /** Token count for a prospective request, used to enforce limits up front. */
  countTokens(request: Pick<AiTaskRequest, 'instructions' | 'evidence'>): Promise<number>;
}
