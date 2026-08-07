import { TECHNOLOGY_CATEGORIES } from '@wdrg/contracts';
import { z } from 'zod';

/**
 * What the recommendation task is allowed to return.
 *
 * Narrow on purpose. The model contributes two things and no more: **which
 * catalogue entry**, and **prose explaining why for this project**. Everything
 * else on a stack component — licence, cost posture, self-hostability,
 * evidence strength, authority, status — is supplied by the application from
 * reviewed data, because those are the facts a client makes commercial
 * decisions on.
 *
 * Three fields are conspicuously absent, and their absence is the design:
 *
 * - **No authority or status.** A model cannot say a technology is
 *   `USER_SELECTED` or `LOCKED`, because there is nowhere to put it. Authority
 *   is assigned by the code that writes the component, and it is always
 *   `AI_RECOMMENDATION`.
 * - **No `deterministic` flag on a warning.** Model observations arrive through
 *   `concerns` and are stored with `deterministic: false`, so a rule and an
 *   opinion cannot be confused on screen.
 * - **No risk level.** `BLOCKING` is reachable only through the deterministic
 *   rules. A model that could label its own observation blocking could stop a
 *   user's choice, which is the one thing it must never do.
 *
 * `.strict()` throughout: a model inventing a field is telling you it
 * misunderstood the task, and silently stripping the evidence of that is how a
 * misunderstanding reaches a proposal.
 */

const shortText = z.string().min(1).max(300);
const rationale = z.string().min(1).max(1200);

/**
 * The model's own estimate of how sure it is.
 *
 * Accepted, stored, labelled — and never used to decide anything. Identical in
 * status to Phase 4's `modelConfidence`, and for the same reason: it is a
 * statement about the model, not about the project.
 */
const modelConfidence = z.number().min(0).max(1);

export const stackRecommendationOutputSchema = z
  .object({
    recommendations: z
      .array(
        z
          .object({
            category: z.enum(TECHNOLOGY_CATEGORIES),
            /** Must exist in the catalogue. Checked semantically, not just here. */
            technologyId: z.string().min(1).max(64),
            /**
             * Why this one, for this project.
             *
             * The prompt asks for requirement ids in the text and the
             * application checks them separately; a rationale that could apply
             * to any project is a rationale that explains nothing.
             */
            rationale,
            /** Requirement ids the model is citing. Verified against the baseline. */
            requirementIds: z.array(z.string().min(1).max(64)).max(20),
            benefits: z.array(shortText).max(6),
            limitations: z.array(shortText).max(6),
            risks: z.array(shortText).max(6),
            operationalConsiderations: z.array(shortText).max(6),
            /** A second option a reasonable person might prefer. */
            alternativeTechnologyId: z.string().max(64).nullable(),
            alternativeReason: z.string().max(600).nullable(),
            modelConfidence,
          })
          .strict(),
      )
      .max(40),
    /**
     * Observations about a technology the *user* chose.
     *
     * The only channel through which the model may comment on a decision it
     * cannot change. Stored as a non-deterministic finding, capped below
     * `BLOCKING`, and shown as the model's opinion rather than as a rule.
     */
    concerns: z
      .array(
        z
          .object({
            category: z.enum(TECHNOLOGY_CATEGORIES),
            summary: shortText,
            impact: z.string().max(600),
            suggestion: z.string().max(600),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export type StackRecommendationOutput = z.infer<typeof stackRecommendationOutputSchema>;
