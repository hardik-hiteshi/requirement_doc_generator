import type { AiFailureReason, AiTaskId, AiUsage, ModelProfile } from '@wdrg/contracts';

/**
 * What every self-hosted inference provider must offer.
 *
 * Narrower than `AiProviderPort`, deliberately. That port describes a *task* —
 * a versioned prompt, typed evidence, a response schema, validation and repair.
 * This describes a single round-trip to a server. Keeping them apart means the
 * task machinery is written once, above the providers, rather than three times
 * inside them.
 */

/**
 * One turn in a conversation.
 *
 * `system` carries application instructions and nothing else. Evidence is always
 * `user`, and always quoted — the separation is structural, so a document that
 * says "ignore previous instructions" arrives as something the model was asked
 * to read rather than something it was told to do.
 */
export interface InferenceMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface InferenceRequest {
  readonly messages: readonly InferenceMessage[];
  readonly model: string;
  /** Ask the server to constrain output to JSON, where it can. */
  readonly jsonMode: boolean;
  readonly maxOutputTokens: number;
  /**
   * Zero, always.
   *
   * Requirement analysis is not a creative task. The same document should
   * produce the same requirements twice, and a deterministic setting is also
   * what makes a failure reproducible enough to debug.
   */
  readonly temperature: number;
  readonly timeoutMs: number;
  /** For logging and cancellation. Never sent to the model. */
  readonly correlationId: string;
  readonly taskId: AiTaskId;
  /** Checked between retries so a cancelled run stops promptly. */
  readonly isCancelled?: () => Promise<boolean>;
}

export interface InferenceResponse {
  readonly content: string;
  readonly usage: AiUsage;
  readonly model: string;
  readonly provider: string;
  /** True when the server stopped because it hit the output ceiling. */
  readonly truncated: boolean;
}

/**
 * A provider failure, carrying the classification a caller acts on.
 *
 * Providers translate their own errors into these reasons so nothing above them
 * has to know what an Ollama error looks like versus a vLLM one.
 */
export class InferenceError extends Error {
  constructor(
    public readonly reason: AiFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'InferenceError';
  }
}

export interface ProviderHealth {
  readonly available: boolean;
  readonly provider: string;
  /** Models the server currently has, where it can be asked. */
  readonly models?: readonly string[];
  /** Safe detail. Never the endpoint's credentials. */
  readonly detail?: string;
}

export interface InferenceProvider {
  readonly name: string;

  /** @throws {InferenceError} for every failure mode. */
  complete(request: InferenceRequest): Promise<InferenceResponse>;

  /**
   * Whether the server is reachable and holds the model.
   *
   * Both halves matter: a running server with the wrong model produces a
   * failure on the first real request, which is the worst moment to find out.
   */
  health(profile: ModelProfile, model: string): Promise<ProviderHealth>;
}
