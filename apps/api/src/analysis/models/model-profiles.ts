import { modelProfileSchema, type ModelProfile } from '@wdrg/contracts';

/**
 * The model profiles this deployment knows about.
 *
 * No model is treated as universally best. Which one is right depends on the
 * hardware available, the licence the organisation can accept, and how good the
 * output needs to be — none of which this codebase can decide for a deployment.
 *
 * **Weights are never committed.** Each profile names where its weights come
 * from and pins an immutable identifier where the distribution offers one.
 *
 * Adding a profile is adding an entry. Nothing in the application knows anything
 * about any particular model.
 */

/**
 * Qwen2.5 7B Instruct — the reference profile.
 *
 * Apache-2.0, which is the reason it is the reference rather than a
 * better-benchmarked alternative: no acceptable-use policy, no user-count
 * threshold, no naming requirement, nothing to route past a lawyer. For a
 * product whose whole constraint is "no vendor dependency", a licence with no
 * conditions is worth more than a few points of benchmark.
 *
 * It is also genuinely good at constrained JSON, which every task here needs.
 */
const QWEN_7B: ModelProfile = {
  id: 'qwen2.5-7b-instruct',
  provider: 'ollama',
  model: 'qwen2.5:7b-instruct',
  displayName: 'Qwen2.5 7B Instruct',

  licence: 'Apache-2.0',
  licenceUrl: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/main/LICENSE',
  commercialUse: 'permitted',
  weightsSource: 'Ollama library: qwen2.5:7b-instruct (upstream Qwen/Qwen2.5-7B-Instruct)',
  weightsDigest: 'ollama:qwen2.5:7b-instruct',
  requiresLegalReview: false,

  contextTokens: 32_768,
  maxOutputTokens: 8_192,
  structuredOutput: true,
  toolUse: true,
  quantization: 'Q4_K_M (Ollama default)',

  recommendedHardware:
    'About 6 GB of memory for the Q4 quantisation. Usable on CPU at roughly 5–15 tokens/second; a GPU with 8 GB or more makes it comfortable.',
  intendedUse:
    'The reference profile for requirement analysis: normalisation, classification, extraction, and the detection tasks.',
  limitations: [
    'A 7B model is not a frontier model. Subtle contradictions across distant parts of a long document are the first thing it misses.',
    'Long structured outputs degrade towards the end; the per-task item ceilings exist partly for this reason.',
    'Weaker on documents that are not in English.',
  ],
  validationStatus: 'untested',
};

/**
 * Qwen2.5 3B Instruct — the fallback, for machines that cannot run 7B.
 *
 * Same licence and the same family, at roughly a third of the memory. It is
 * meaningfully worse at the harder tasks — conflict detection especially, which
 * needs holding two statements in mind at once — and that is recorded in its
 * limitations rather than left to be discovered.
 *
 * This profile is validated because it is what the development machine here can
 * actually run: 15 GB total memory with a Docker stack alongside it does not
 * leave room for the 7B weights.
 */
const QWEN_3B: ModelProfile = {
  id: 'qwen2.5-3b-instruct',
  provider: 'ollama',
  model: 'qwen2.5:3b-instruct',
  displayName: 'Qwen2.5 3B Instruct',

  licence: 'Apache-2.0',
  licenceUrl: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE',
  commercialUse: 'permitted',
  weightsSource: 'Ollama library: qwen2.5:3b-instruct (upstream Qwen/Qwen2.5-3B-Instruct)',
  weightsDigest: 'ollama:qwen2.5:3b-instruct',
  requiresLegalReview: false,

  contextTokens: 32_768,
  maxOutputTokens: 4_096,
  structuredOutput: true,
  toolUse: false,
  quantization: 'Q4_K_M (Ollama default)',

  recommendedHardware:
    'About 2.5 GB of memory. Runs acceptably on CPU alone, which is what makes it the fallback.',
  intendedUse:
    'Development, and deployments whose hardware cannot hold the 7B weights. Suitable for the whole pipeline, with lower quality on the detection tasks.',
  limitations: [
    'Noticeably weaker than 7B at conflict detection, which requires relating two statements that may be pages apart.',
    'More likely to over-produce requirement items from a single sentence, which the duplicate pass then has to clean up.',
    'Shorter usable output, so chunk sizes have to be smaller.',
  ],
  validationStatus: 'development-validated',
  validationNotes:
    'Verified against Ollama 0.32.6 on CPU: connectivity, model availability, a schema-valid structured response, and timeout handling. Not production-approved — quality on the detection tasks has not been assessed against a labelled corpus.',
};

/**
 * A self-hosted OpenAI-compatible server, as a shape rather than a model.
 *
 * vLLM, llama.cpp's server and TGI all speak this protocol, and which weights
 * sit behind it is a deployment's choice. The context and output limits here are
 * conservative placeholders that a deployment overrides with
 * `AI_MAX_CONTEXT_TOKENS` and `AI_MAX_OUTPUT_TOKENS`, because the server's real
 * limits depend on how it was launched.
 *
 * Deliberately not production-approved: a profile that does not name a model
 * cannot have had its licence recorded, and approving it would let any model
 * through the gate that exists to stop exactly that.
 */
const SELF_HOSTED_OPENAI: ModelProfile = {
  id: 'self-hosted-openai-compatible',
  provider: 'local-openai-compatible',
  model: 'configured-by-deployment',
  displayName: 'Self-hosted OpenAI-compatible server',

  licence: 'Depends on the model served — record it before production use',
  commercialUse: 'requires-legal-review',
  commercialUseConditions:
    "This profile does not name a model, so no licence has been recorded. Copy it, name the model you serve, record that model's licence, and set validationStatus once both licence and behaviour have been checked.",
  weightsSource: 'Whatever the configured server hosts',
  requiresLegalReview: true,

  contextTokens: 8_192,
  maxOutputTokens: 2_048,
  structuredOutput: true,
  toolUse: false,

  recommendedHardware: 'Whatever the chosen model needs. vLLM in particular expects a GPU.',
  intendedUse:
    'Production, against an inference server on your own infrastructure. Override the limits to match how the server was launched.',
  limitations: [
    'Names no model, so its licence and capabilities are unknown until a deployment fills them in.',
    'The context and output limits here are placeholders, not measurements.',
  ],
  validationStatus: 'untested',
};

/**
 * The deterministic test provider.
 *
 * Returns fixtures. It exists so business logic can be tested without a model,
 * and so CI never downloads gigabytes of weights to check that a state machine
 * works. `isProductionUsable` refuses it unconditionally, and startup enforces
 * that — a test double reaching a real project would produce a requirement
 * baseline made of nothing.
 */
const DETERMINISTIC: ModelProfile = {
  id: 'deterministic-test',
  provider: 'deterministic',
  model: 'deterministic-fixtures',
  displayName: 'Deterministic test provider',

  licence: 'Not applicable — no model',
  commercialUse: 'prohibited',
  commercialUseConditions: 'This is a test fixture, not a model. It must never analyse real work.',
  weightsSource: 'None',
  requiresLegalReview: false,

  contextTokens: 32_768,
  maxOutputTokens: 8_192,
  structuredOutput: true,
  toolUse: false,

  recommendedHardware: 'None.',
  intendedUse: 'Unit, integration and browser tests. Never production.',
  limitations: ['Returns fixtures. It does not analyse anything.'],
  validationStatus: 'development-validated',
  validationNotes: 'Deterministic by construction: the same input always produces the same output.',
};

/** Every known profile, validated against the contract at module load. */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  QWEN_7B,
  QWEN_3B,
  SELF_HOSTED_OPENAI,
  DETERMINISTIC,
].map((profile) => modelProfileSchema.parse(profile));

export function findModelProfile(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((profile) => profile.id === id);
}

/** The profiles a given provider can serve, for a configuration error message. */
export function profilesForProvider(provider: ModelProfile['provider']): ModelProfile[] {
  return MODEL_PROFILES.filter((profile) => profile.provider === provider);
}
