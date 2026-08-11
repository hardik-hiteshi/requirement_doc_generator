import { z } from 'zod';

import {
  assumptionCandidateSchema,
  clientDependencyDraftSchema,
  sowSectionDraftSchema,
  wbsTaskDraftSchema,
  MODEL_RAISABLE_KINDS,
} from '@wdrg/contracts';

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

/* ------------------------------------------ Phase 8: acceptance criteria */

/**
 * Acceptance conditions, as wording.
 *
 * No `criterionKey` — the application assigns them, so a model cannot renumber a
 * document or overwrite a criterion by claiming its key. No `status`, so it cannot
 * mark anything agreed. No `aspect`, because which class of condition this is
 * follows from the requirement and is the application's judgement. And nothing
 * resembling effort, a date or a threshold field: those have nowhere to go.
 */
export const acceptanceCriteriaOutputSchema = z
  .object({
    criteria: z
      .array(
        z
          .object({
            /** Must be a feature the run was given. Checked semantically. */
            featureId: z.string().min(1).max(64),
            requirementIds: z.array(z.string().max(64)).max(40),
            given: z.string().max(1_000),
            when: z.string().max(1_000),
            then: z.string().min(1).max(2_000),
            rule: z.string().max(1_000),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type AcceptanceCriteriaOutput = z.infer<typeof acceptanceCriteriaOutputSchema>;

/* -------------------------------------------------- Phase 8: assumptions */

/**
 * Assumption candidates.
 *
 * The schema is `assumptionCandidateSchema` from the contracts, unchanged, because
 * the absence of `status`, `provenance`, `owner` and `confirmedBy` there is the
 * whole safety property and it should be stated in one place.
 */
export const assumptionCandidatesOutputSchema = z
  .object({ assumptions: z.array(assumptionCandidateSchema).max(60) })
  .strict();

export type AssumptionCandidatesOutput = z.infer<typeof assumptionCandidatesOutputSchema>;

/* ---------------------------------------------- Phase 8: statement of work */

/**
 * One SOW section, as prose.
 *
 * Nowhere to put a date, a duration, an hours figure, a price, a technology
 * version or a status. The sections that carry those facts are composed by the
 * application and are not model-writable at all — see
 * `MODEL_WRITABLE_SOW_SECTIONS`.
 */
export const sowSectionOutputSchema = sowSectionDraftSchema;

export type SowSectionOutput = z.infer<typeof sowSectionOutputSchema>;

/* ------------------------------------ Phase 9: work breakdown structure */

/**
 * Task wording and an optional decomposition.
 *
 * The schema is `wbsTaskDraftSchema` from the contracts, unchanged, because what it
 * *lacks* is the safety property and that belongs stated in one place: no hours, no
 * days, no dates, no critical-path flag, no status. A model can say a unit of work
 * splits into validation, business logic and persistence, and give their relative
 * sizes; the application divides the approved hours across them so the parts still
 * sum to what was approved.
 *
 * A model that tries to state forty hours produces a parse failure, not a plausible
 * figure that quietly disagrees with the estimate.
 */
export const wbsTasksOutputSchema = z
  .object({ tasks: z.array(wbsTaskDraftSchema).max(400) })
  .strict();

export type WbsTasksOutput = z.infer<typeof wbsTasksOutputSchema>;

/* ------------------------------------- Phase 9: client dependency sheet */

/**
 * Client dependencies a model believes the approved scope implies.
 *
 * `clientDependencyDraftSchema` unchanged, for the same reason: it has no owner, no
 * due date, no status, no priority and no blocking classification. Those either
 * commit a named person or declare work unblocked, and neither is a judgement to take
 * from a generated suggestion.
 *
 * Nor is there anywhere to put a credential. The application refuses secret-shaped
 * text on every write path regardless, but a field that does not exist cannot be
 * filled in by accident.
 */
export const clientDependenciesOutputSchema = z
  .object({ dependencies: z.array(clientDependencyDraftSchema).max(200) })
  .strict();

export type ClientDependenciesOutput = z.infer<typeof clientDependenciesOutputSchema>;
