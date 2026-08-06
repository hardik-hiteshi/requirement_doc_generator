/**
 * Outbound boundary for AI model calls.
 *
 * First adapter: Phase 4, against **inference the operator runs themselves** —
 * Ollama in development, an OpenAI-protocol-compatible server such as vLLM in
 * production. Never a hosted model vendor. See ADR-0017.
 *
 * Two properties this contract exists to guarantee:
 *
 * **No requirement content leaves the operator's infrastructure.** The evidence
 * these calls carry is a client's scope, commercial terms and sometimes their
 * contract. Where that goes is a disclosure decision, and it is not one this
 * codebase makes on a deployment's behalf.
 *
 * **The application never sends a free-form prompt and hopes.** Every call names
 * a versioned task, supplies evidence *separately* from instructions, and
 * declares the JSON schema the response must satisfy — which is what makes
 * responses validatable, prompts auditable, and the provider replaceable.
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

/**
 * What a call consumed.
 *
 * Token counts are about context-window pressure and the compute the operator is
 * paying for in electricity and hardware — not about a vendor invoice. There is
 * no per-token charge to report, because there is no vendor.
 */
export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Reused from a prefix cache, where the inference server implements one. */
  readonly cachedInputTokens: number;
  /** Wall-clock time on the operator's own hardware. */
  readonly durationMs: number;
}

export interface AiTaskResult<TOutput> {
  /** Response parsed and validated against `responseSchema`. */
  readonly output: TOutput;
  readonly usage: AiUsage;
  /**
   * Model and provider that produced the output, for audit.
   *
   * Recorded because output attribution matters when a document is signed: which
   * model, running where, produced this estimate.
   */
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
  | 'provider_unavailable' // The self-hosted inference server is not reachable.
  | 'budget_exceeded' // Would breach the configured token or context limit.
  | 'content_refused'; // The model declined the request.

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
