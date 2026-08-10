import { z } from 'zod';

import { MODEL_RAISABLE_KINDS } from '@wdrg/contracts';

/**
 * What the model is allowed to return, per Phase 7 task.
 *
 * Every schema is `.strict()`, and the absences are the design. What a schema has
 * nowhere to put, a model cannot supply — which is a stronger guarantee than an
 * instruction saying please do not, and it is checked before anything is stored.
 *
 * The four that matter:
 *
 * **No hours, anywhere.** `documentFeaturesSchema` has no effort field of any
 * kind. Hours come from the approved estimate, and a number arriving here would
 * silently replace a figure somebody signed.
 *
 * **No status, no version, no approval.** A model cannot mark a document
 * approved, current or final, because those are decisions with authority behind
 * them.
 *
 * **No source locations.** A page or line number the model produced would be a
 * plausible fabrication in a citation. Locations are copied from the
 * requirement's own verified traceability link.
 *
 * **No new sections.** `documentPlanSchema` assigns requirements to sections the
 * application already declared; the key is validated against the template.
 */

/* --------------------------------------------------------------- planning */

export const documentPlanSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            /** Must be one of the template's keys. Checked semantically. */
            key: z.string().min(1).max(64),
            requirementIds: z.array(z.string().max(64)).max(200),
            /** False when the evidence supports nothing for this heading. */
            hasEvidence: z.boolean(),
            /** Why it is empty. Null when it is not. */
            omittedReason: z.string().max(300).nullable(),
          })
          .strict(),
      )
      .max(60),
    /** Requirements the model could not place. Reported, never forced. */
    unassignedRequirementIds: z.array(z.string().max(64)).max(500),
  })
  .strict();

export type DocumentPlan = z.infer<typeof documentPlanSchema>;

/* ------------------------------------------------------- section prose */

export const documentSectionOutputSchema = z
  .object({
    /** The section, as prose. */
    body: z.string().max(20_000),
    /** Requirements the section relies on. Verified against what was supplied. */
    requirementIds: z.array(z.string().max(64)).max(200),
    /**
     * Statements the model itself could not support.
     *
     * A model that notices it has overreached and says so is more useful than
     * one that quietly does not — and this is checked against the deterministic
     * content rules regardless.
     */
    unsupportedStatements: z.array(z.string().max(600)).max(20),
  })
  .strict();

export type DocumentSectionOutput = z.infer<typeof documentSectionOutputSchema>;

/* ------------------------------------------------------------- features */

export const documentFeaturesSchema = z
  .object({
    features: z
      .array(
        z
          .object({
            module: z.string().min(1).max(200),
            submodule: z.string().max(200),
            /** Empty for work with no interface. An API endpoint is not a screen. */
            screen: z.string().max(200),
            description: z.string().min(1).max(4_000),
            requirementIds: z.array(z.string().max(64)).min(1).max(50),
          })
          .strict(),
      )
      .max(2_000),
  })
  .strict();

export type DocumentFeaturesOutput = z.infer<typeof documentFeaturesSchema>;

/* ----------------------------------------------------------- validation */

export const documentValidationOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            /**
             * Restricted to the judgement kinds.
             *
             * A model cannot raise `effort_mismatch` or `unknown_requirement`:
             * those are arithmetic the application has already done, and an
             * opinion about them would be noise at best.
             */
            kind: z.enum(MODEL_RAISABLE_KINDS as [string, ...string[]]),
            /** Which section it is in. Checked against the document. */
            sectionKey: z.string().max(64),
            /** The sentence, quoted, so a reviewer can find it. */
            statement: z.string().min(1).max(600),
            explanation: z.string().min(1).max(600),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type DocumentValidationOutput = z.infer<typeof documentValidationOutputSchema>;
