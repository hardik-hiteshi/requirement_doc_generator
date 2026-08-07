import { z } from 'zod';

/**
 * A model, described well enough to choose between models.
 *
 * No model is hardcoded as best. Which one is right depends on the hardware
 * available, the licence the organisation can accept, and how good the output
 * has to be — three questions this codebase cannot answer for a deployment.
 *
 * A profile is therefore data, and the application reads it rather than knowing
 * anything about any particular model.
 *
 * **Weights are never committed to Git.** They are large, they are not source,
 * and several model licences forbid redistribution. A profile names a model and
 * records where it came from; it does not carry one.
 */

export const MODEL_PROVIDERS = ['ollama', 'local-openai-compatible', 'deterministic'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * How settled a profile is.
 *
 * `production-approved` is a claim about licence *and* behaviour, and it is only
 * made after both have been checked — a profile nobody has run is `untested`,
 * however good the model is said to be.
 */
export const MODEL_VALIDATION_STATUSES = [
  'untested',
  'development-validated',
  'production-approved',
  'rejected',
] as const;

export type ModelValidationStatus = (typeof MODEL_VALIDATION_STATUSES)[number];

/**
 * Whether the licence permits commercial use, and how confidently.
 *
 * `permitted-with-conditions` exists because several widely-used model licences
 * — Meta's community licence most prominently — do permit commercial use while
 * attaching an acceptable-use policy, a user-count threshold and naming
 * requirements. Recording that as a plain "yes" would hide the conditions from
 * the person who has to comply with them.
 */
export const COMMERCIAL_USE_STATUSES = [
  'permitted',
  'permitted-with-conditions',
  'prohibited',
  'requires-legal-review',
] as const;

export type CommercialUseStatus = (typeof COMMERCIAL_USE_STATUSES)[number];

export const modelProfileSchema = z
  .object({
    /** Stable identifier, recorded on every analysis run for attribution. */
    id: z.string().min(1).max(80),
    provider: z.enum(MODEL_PROVIDERS),
    /** As the inference server knows it, e.g. `qwen2.5:7b-instruct`. */
    model: z.string().min(1).max(120),
    displayName: z.string().min(1).max(120),

    /* ------------------------------------------------------------ licence */
    licence: z.string().min(1).max(120),
    licenceUrl: z.string().max(500).optional(),
    commercialUse: z.enum(COMMERCIAL_USE_STATUSES),
    /** The conditions, in plain language, when there are any. */
    commercialUseConditions: z.string().max(2_000).optional(),
    /** Where the weights come from. Never a location inside this repository. */
    weightsSource: z.string().max(500),
    /**
     * An immutable identifier for the exact weights, where the distribution
     * offers one — a digest, or a pinned tag. "Qwen2.5 7B" names a family;
     * this names a file.
     */
    weightsDigest: z.string().max(200).optional(),
    /** True when the licence needs a lawyer before production use. */
    requiresLegalReview: z.boolean(),

    /* ----------------------------------------------------------- capacity */
    contextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    /**
     * Whether the model reliably returns valid JSON against a schema.
     *
     * Load-bearing: every task in this phase returns structured output, so a
     * model that cannot do it is unusable here regardless of its other merits.
     */
    structuredOutput: z.boolean(),
    toolUse: z.boolean(),
    quantization: z.string().max(60).optional(),

    /* -------------------------------------------------------- operational */
    recommendedHardware: z.string().max(500),
    intendedUse: z.string().max(500),
    /** What it is *not* good at. Stated so nobody has to discover it. */
    limitations: z.array(z.string().max(500)).max(20),
    validationStatus: z.enum(MODEL_VALIDATION_STATUSES),
    validatedAt: z.iso.datetime().optional(),
    /** What was actually run against it, when it was validated. */
    validationNotes: z.string().max(2_000).optional(),
  })
  .strict();

export type ModelProfile = z.infer<typeof modelProfileSchema>;

/**
 * Whether a profile may be used in production.
 *
 * Three independent gates, and all three are about not discovering a problem
 * later: the deterministic provider is a test fixture and must never analyse a
 * real project; an unvalidated profile is an untested one; and a licence needing
 * review has not had it.
 */
export function isProductionUsable(profile: ModelProfile): {
  usable: boolean;
  reason?: string;
} {
  if (profile.provider === 'deterministic') {
    return {
      usable: false,
      reason:
        'The deterministic test provider returns fixtures, not analysis. It exists for tests and must never run against a real project.',
    };
  }

  if (profile.validationStatus !== 'production-approved') {
    return {
      usable: false,
      reason: `Model profile "${profile.id}" is ${profile.validationStatus}, not production-approved.`,
    };
  }

  if (profile.commercialUse === 'prohibited') {
    return {
      usable: false,
      reason: `The licence for "${profile.id}" does not permit commercial use.`,
    };
  }

  if (profile.requiresLegalReview) {
    return {
      usable: false,
      reason: `The licence for "${profile.id}" is flagged for legal review, which has not been recorded as complete.`,
    };
  }

  return { usable: true };
}

/** Whether a profile can produce the structured output every task requires. */
export function supportsAnalysis(profile: ModelProfile): boolean {
  return profile.structuredOutput;
}
