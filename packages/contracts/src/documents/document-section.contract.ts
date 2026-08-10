import { z } from 'zod';

/**
 * One section of a prose document, and the rules that keep a person's writing
 * from being overwritten by a model.
 *
 * ## Why a section has an origin
 *
 * `GENERATED` content may be replaced by regeneration without asking. Content a
 * person wrote may not — not because their prose is better, but because
 * replacing it discards a decision, and the application cannot tell which
 * sentence was the decision. So a regeneration that touches an edited section
 * produces a *proposal* and stops. The user takes one of three actions, and all
 * three are theirs.
 */

export const SECTION_ORIGINS = [
  /** Written by a generation run and untouched since. */
  'GENERATED',
  /** Edited by a person. Protected from silent replacement. */
  'USER_EDITED',
  /** Written by a person from nothing. Also protected. */
  'USER_AUTHORED',
] as const;

export type SectionOrigin = (typeof SECTION_ORIGINS)[number];
export const sectionOriginSchema = z.enum(SECTION_ORIGINS);

/** Whether regeneration must ask before replacing this section. */
export function isSectionProtected(origin: SectionOrigin): boolean {
  return origin === 'USER_EDITED' || origin === 'USER_AUTHORED';
}

/** What a user may do with a proposed replacement for a protected section. */
export const REVISION_DECISIONS = [
  'KEEP_CURRENT',
  'ACCEPT_GENERATED_REVISION',
  'EDIT_GENERATED_REVISION',
] as const;

export type RevisionDecision = (typeof REVISION_DECISIONS)[number];

export const REVISION_DECISION_LABELS: Readonly<Record<RevisionDecision, string>> = {
  KEEP_CURRENT: 'Keep what I wrote',
  ACCEPT_GENERATED_REVISION: 'Use the new version',
  EDIT_GENERATED_REVISION: 'Start from the new version and edit it',
};

/* --------------------------------------------------------- traceability */

/**
 * Where a statement came from.
 *
 * Every reference names something that exists in this project. Nothing here is
 * ever constructed from a model's claim about a source: a page number the model
 * produced is a plausible-looking fabrication, and a fabricated citation is
 * worse than none because it survives review.
 */
export const REFERENCE_KINDS = [
  'REQUIREMENT',
  'CLARIFICATION',
  'TECHNOLOGY_COMPONENT',
  'ESTIMATE_UNIT',
  /** A location inside an uploaded source, inherited from Phase 3. */
  'SOURCE_LOCATION',
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const documentReferenceSchema = z
  .object({
    kind: z.enum(REFERENCE_KINDS),
    /** Identifier of the referenced thing, verified to exist before storage. */
    id: z.string().min(1).max(64),
    /** Display label. Never a substitute for the id. */
    label: z.string().max(300).optional(),
    /**
     * Inherited source location. Present only when the referenced requirement
     * carries one — this is copied, never derived.
     */
    sourceId: z.string().max(64).optional(),
    pageNumber: z.number().int().positive().optional(),
    lineNumber: z.number().int().positive().optional(),
    sheetName: z.string().max(120).optional(),
    cellRange: z.string().max(40).optional(),
  })
  .strict();

export type DocumentReference = z.infer<typeof documentReferenceSchema>;

/* ------------------------------------------------------------- sections */

export const SECTION_LIMITS = {
  body: { min: 0, max: 20_000 },
  title: { max: 200 },
  perDocument: 60,
  references: 200,
} as const;

export const documentSectionSchema = z
  .object({
    sectionId: z.string().min(1).max(64),
    /** Stable key from the document's template, so a section survives reordering. */
    key: z.string().min(1).max(64),
    title: z.string().min(1).max(SECTION_LIMITS.title.max),
    order: z.number().int().nonnegative(),
    body: z.string().max(SECTION_LIMITS.body.max),
    origin: sectionOriginSchema,
    /**
     * Sections a template declares but the evidence does not support.
     *
     * Kept in the document as an empty section with a reason rather than
     * dropped, because "we have nothing about integrations" and "we forgot
     * integrations" look identical once the heading is gone.
     */
    omittedReason: z.string().max(300).optional(),
    references: z.array(documentReferenceSchema).max(SECTION_LIMITS.references),
    /** A replacement waiting for a decision. Only on a protected section. */
    proposedBody: z.string().max(SECTION_LIMITS.body.max).optional(),
    proposedAt: z.string().datetime().optional(),
    /** Why the last regeneration ran, when a user gave a reason. */
    regenerationReason: z.string().max(500).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type DocumentSection = z.infer<typeof documentSectionSchema>;

export function hasProposal(section: DocumentSection): boolean {
  return typeof section.proposedBody === 'string' && section.proposedBody.length > 0;
}

/**
 * Whether generated content may be written straight into this section.
 *
 * The single rule the whole edit-authority requirement reduces to, in one
 * place: unprotected sections are replaced, protected ones get a proposal.
 */
export function mayReplaceDirectly(section: DocumentSection): boolean {
  return !isSectionProtected(section.origin);
}

/* --------------------------------------------------------- write shapes */

export const updateSectionSchema = z
  .object({
    title: z.string().min(1).max(SECTION_LIMITS.title.max).optional(),
    body: z.string().max(SECTION_LIMITS.body.max),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateSection = z.infer<typeof updateSectionSchema>;

export const resolveSectionProposalSchema = z
  .object({
    decision: z.enum(REVISION_DECISIONS),
    /** Required for `EDIT_GENERATED_REVISION`, refused otherwise. */
    body: z.string().max(SECTION_LIMITS.body.max).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => (value.decision === 'EDIT_GENERATED_REVISION') === (value.body !== undefined),
    {
      message: 'A body belongs with EDIT_GENERATED_REVISION and with nothing else',
      path: ['body'],
    },
  );

export type ResolveSectionProposal = z.infer<typeof resolveSectionProposalSchema>;

/**
 * A correction the user wants applied on the next generation.
 *
 * **Untrusted input.** It is evidence about what the user wants, never an
 * instruction to the system: it travels in the evidence channel, and no prompt
 * interpolates it. It cannot widen scope, name a technology, change an hours
 * figure or reach an upstream artifact — those are all decisions with their own
 * authority, and a sentence in a text box does not carry it.
 */
export const CORRECTION_LIMITS = { instruction: { max: 2_000 } } as const;

export const regenerateSectionSchema = z
  .object({
    /** What the user wants different. Optional; regeneration works without it. */
    instruction: z.string().max(CORRECTION_LIMITS.instruction.max).optional(),
    useAi: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RegenerateSection = z.infer<typeof regenerateSectionSchema>;
