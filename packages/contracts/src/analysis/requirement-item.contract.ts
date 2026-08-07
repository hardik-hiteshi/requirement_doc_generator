import { z } from 'zod';

import { ANALYSIS_LIMITS } from './analysis-limits';
import { proposedRevisionSchema } from './clarification.contract';
import { sourceReferenceSchema } from '../requirements/extracted-content.contract';

/**
 * A requirement, as this application understands one.
 *
 * The unit everything else in Phase 4 operates on: duplicates group them,
 * conflicts relate them, clarifications hang off them, and a baseline is a set
 * of them at a version. Three properties are load-bearing.
 *
 * **Every item traces to evidence.** A requirement with no source reference is
 * something the model produced from nothing, and there is no way for a client to
 * check it. Such an item is not silently dropped — it is kept, marked, and it
 * blocks approval, because a silent drop hides the fact that the model
 * hallucinated.
 *
 * **Two confidences, never merged.** The model's self-assessment is an opinion
 * and is labelled as one. The evidence-derived score is calculated by
 * application code from traceability and source quality, and it is what controls
 * review priority and approval. Averaging them would produce a number meaning
 * neither thing.
 *
 * **A human's edit outranks the model.** `editedByUser` is permanent once set.
 * Re-analysis proposes; it does not overwrite.
 */

/* --------------------------------------------------------- categories */

export const REQUIREMENT_CATEGORIES = [
  /** Something the system must do. */
  'functional',
  /** A stated quality expectation. Never inferred — see the note below. */
  'non_functional',
  /** A rule the business imposes on behaviour. */
  'business_rule',
  /** A limit the solution must work within: platform, budget, deadline, law. */
  'constraint',
  /** A named external system this one must exchange data with. */
  'integration',
  /** An entity, field or data expectation the system must hold. */
  'data',
  /** A named actor and what they are allowed to do. */
  'user_role',
  /**
   * Something taken as true that the sources do not state.
   *
   * Only ever created by an explicit human action — confirming a clarification
   * answer, or adding one by hand. The analysis never converts a missing detail
   * into an assumption on its own: doing so would turn a known gap into an
   * apparent fact, which is the single most expensive mistake this document can
   * contain.
   */
  'assumption',
  /** Explicitly stated as not included. */
  'out_of_scope',
] as const;

export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];
export const requirementCategorySchema = z.enum(REQUIREMENT_CATEGORIES);

export const REQUIREMENT_CATEGORY_LABELS: Readonly<Record<RequirementCategory, string>> = {
  functional: 'Functional',
  non_functional: 'Non-functional',
  business_rule: 'Business rule',
  constraint: 'Constraint',
  integration: 'Integration',
  data: 'Data',
  user_role: 'User role',
  assumption: 'Assumption',
  out_of_scope: 'Out of scope',
};

/**
 * The quality dimension a non-functional requirement is about.
 *
 * Required when the category is `non_functional`, and that is deliberate: a
 * quality expectation that cannot be assigned a dimension is usually not one.
 * "The system should be good" is not a performance requirement, and forcing the
 * classification makes the vagueness visible rather than dressing it up.
 */
export const NFR_DIMENSIONS = [
  'performance',
  'scalability',
  'availability',
  'security',
  'privacy',
  'usability',
  'accessibility',
  'maintainability',
  'compatibility',
  'compliance',
  'observability',
] as const;

export type NfrDimension = (typeof NFR_DIMENSIONS)[number];
export const nfrDimensionSchema = z.enum(NFR_DIMENSIONS);

/**
 * MoSCoW, plus the honest fourth option.
 *
 * `unspecified` is the default and is not a failure. Most requirement documents
 * do not state priority, and a model asked to supply one will oblige — which
 * manufactures a decision the client never made.
 */
export const REQUIREMENT_PRIORITIES = ['must', 'should', 'could', 'wont', 'unspecified'] as const;

export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];
export const requirementPrioritySchema = z.enum(REQUIREMENT_PRIORITIES);

export const REQUIREMENT_ORIGINS = [
  /** Extracted by the analysis pipeline. */
  'ai',
  /** Typed by a person. */
  'manual',
  /** Created from a confirmed clarification answer. */
  'clarification',
] as const;

export type RequirementOrigin = (typeof REQUIREMENT_ORIGINS)[number];
export const requirementOriginSchema = z.enum(REQUIREMENT_ORIGINS);

export const REQUIREMENT_STATUSES = [
  /** Produced by analysis, not yet looked at. */
  'draft',
  /** A person has read it and agreed. */
  'accepted',
  /** A person has changed the wording or the classification. */
  'edited',
  /** A person has rejected it. Kept, not deleted — the rejection is a decision. */
  'rejected',
  /** Replaced by another item, through a duplicate merge. */
  'superseded',
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
export const requirementStatusSchema = z.enum(REQUIREMENT_STATUSES);

/** Statuses that put an item in the baseline. */
export const IN_BASELINE_STATUSES: readonly RequirementStatus[] = ['draft', 'accepted', 'edited'];

export function isInBaseline(status: RequirementStatus): boolean {
  return IN_BASELINE_STATUSES.includes(status);
}

/* ------------------------------------------------------- traceability */

/**
 * What kind of thing a requirement is traced to.
 *
 * A confirmed clarification answer is evidence in exactly the way a document is
 * — arguably better evidence, because somebody was asked directly and said yes.
 * Modelling it as a second kind of link rather than as a pseudo-document keeps
 * the verification honest: a document excerpt is checked against stored block
 * text, and a clarification excerpt is the answer this application recorded, so
 * there is nothing to check it against and nothing to pretend about.
 */
export const EVIDENCE_KINDS = ['document', 'clarification'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);

/**
 * One link from a requirement back to the words it came from.
 *
 * `excerpt` is the model's quotation of the source. It is verified against the
 * block's real text by application code — a quotation that does not appear in
 * the block is a fabricated citation, and the evidence score says so. The model
 * is not trusted to mark its own homework here.
 */
export const traceabilityLinkSchema = z
  .object({
    kind: evidenceKindSchema,
    /** A source id, or a clarification id when `kind` is `clarification`. */
    sourceId: z.string().min(1).max(64),
    /** An extracted block, or `answer-vN` for a clarification answer. */
    blockId: z.string().min(1).max(64),
    /** Verbatim from the source, as the model quoted it. */
    excerpt: z.string().min(1).max(ANALYSIS_LIMITS.maxExcerptLength),
    /** Copied from the block, never invented by the model. */
    reference: sourceReferenceSchema,
    /**
     * Whether the excerpt was found in the cited block, checked by this
     * application rather than claimed by the model.
     *
     * Always true for a clarification link: the text is the answer this
     * application stored, so there is no third party's claim to check.
     */
    verified: z.boolean(),
    /** Human-facing citation for a clarification link, e.g. `Q-004`. */
    label: z.string().max(64).optional(),
  })
  .strict();

export type TraceabilityLink = z.infer<typeof traceabilityLinkSchema>;

/* -------------------------------------------------------- confidences */

export const CONFIDENCE_BANDS = ['high', 'medium', 'low', 'unsupported'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];
export const confidenceBandSchema = z.enum(CONFIDENCE_BANDS);

/**
 * What the model said about its own output.
 *
 * **Not a probability.** A language model's stated confidence is a token
 * sequence that correlates loosely, if at all, with correctness; it is stored
 * because it is occasionally informative and shown because hiding it would be
 * worse, but it is labelled as an AI self-assessment everywhere it appears and
 * it never gates anything.
 */
export const modelConfidenceSchema = z
  .object({
    /** 0–1 as the model reported it. Its own opinion, nothing more. */
    value: z.number().min(0).max(1),
    /** The model's reason, when it gave one. */
    note: z.string().max(500).optional(),
  })
  .strict();

export type ModelConfidence = z.infer<typeof modelConfidenceSchema>;

/** The label shown wherever a model-reported confidence is displayed. */
export const MODEL_CONFIDENCE_LABEL = 'AI self-assessment';
export const MODEL_CONFIDENCE_CAVEAT =
  'The model’s own opinion of this item. It is not a probability and it does not affect approval.';

/**
 * The signals that make up an evidence-derived score.
 *
 * Every one is a fact application code can check against stored data. None of
 * them asks the model anything, which is the entire point: the score that
 * controls approval must not be assignable by the thing being assessed.
 */
export const EVIDENCE_SIGNALS = [
  'has_source_reference',
  'verbatim_support',
  'partial_support',
  'precise_location',
  'multiple_sources',
  'reviewed_content',
  'high_extraction_confidence',
  'confirmed_clarification',
  'human_accepted',
  /* Negative. */
  'no_source_reference',
  'unverified_excerpt',
  'ocr_sourced',
  'low_extraction_confidence',
  'conflicting_evidence',
  'ambiguous_language',
  'unreviewed_content',
] as const;

export type EvidenceSignal = (typeof EVIDENCE_SIGNALS)[number];
export const evidenceSignalSchema = z.enum(EVIDENCE_SIGNALS);

export const evidenceContributionSchema = z
  .object({
    signal: evidenceSignalSchema,
    /** Signed. Negative signals subtract, and the display says so. */
    weight: z.number(),
    /** Plain language, shown to the reviewer. This is the explanation. */
    explanation: z.string().min(1).max(300),
  })
  .strict();

export type EvidenceContribution = z.infer<typeof evidenceContributionSchema>;

/**
 * The score that actually governs.
 *
 * Deterministic, explainable, and computed from stored evidence. It drives
 * review ordering and it is one of the things that can block approval. If it
 * cannot be explained by listing its contributions, it is wrong.
 */
export const evidenceConfidenceSchema = z
  .object({
    score: z.number().min(0).max(1),
    band: confidenceBandSchema,
    contributions: z.array(evidenceContributionSchema).max(20),
    /** The version of the scoring rules, so an old score can be interpreted. */
    ruleVersion: z.string().min(1).max(20),
    calculatedAt: z.iso.datetime(),
  })
  .strict();

export type EvidenceConfidence = z.infer<typeof evidenceConfidenceSchema>;

/* ---------------------------------------------------- requirement item */

export const requirementItemSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    /** The run that produced it. A manual item records the run it was added to. */
    runId: z.string().min(1).max(64),
    /** Stable, human-facing: REQ-001. Assigned in order, never reused. */
    key: z.string().regex(/^REQ-\d{3,5}$/),
    title: z.string().min(1).max(ANALYSIS_LIMITS.maxTitleLength),
    statement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    category: requirementCategorySchema,
    nfrDimension: nfrDimensionSchema.optional(),
    priority: requirementPrioritySchema,
    /** Empty only for a manual item a person chose not to trace. */
    references: z.array(traceabilityLinkSchema).max(ANALYSIS_LIMITS.maxReferencesPerItem),
    modelConfidence: modelConfidenceSchema.optional(),
    evidenceConfidence: evidenceConfidenceSchema,
    origin: requirementOriginSchema,
    status: requirementStatusSchema,
    /**
     * Set the first time a person changes this item, and never cleared.
     *
     * Re-analysis reads it and refuses to overwrite: a later run may *propose* a
     * different wording, but a human decision is not undone by a machine.
     */
    editedByUser: z.boolean(),
    /** Which chunks produced it. More than one means it was reconciled. */
    chunkIds: z.array(z.string().max(80)).max(50),
    /** Set when a duplicate merge replaced this item with another. */
    supersededById: z.string().max(64).optional(),
    /**
     * A revision waiting for a person, from a clarification that touched this.
     *
     * Present only where the change could not be applied automatically —
     * a requirement somebody edited, wrote, or already approved.
     */
    proposedRevision: proposedRevisionSchema.optional(),
    /**
     * Set when something happened that this requirement has not been checked
     * against yet — a clarification answer changing, most often.
     */
    needsRevalidation: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Optimistic concurrency, as everywhere else in this application. */
    version: z.number().int().nonnegative(),
  })
  .strict();

export type RequirementItem = z.infer<typeof requirementItemSchema>;

/** What a reviewer may change. Everything else is derived or historical. */
export const requirementItemEditSchema = z
  .object({
    title: z.string().min(1).max(ANALYSIS_LIMITS.maxTitleLength).optional(),
    statement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength).optional(),
    category: requirementCategorySchema.optional(),
    nfrDimension: nfrDimensionSchema.nullable().optional(),
    priority: requirementPrioritySchema.optional(),
    status: z.enum(['accepted', 'rejected', 'draft']).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (edit) => Object.keys(edit).some((key) => key !== 'expectedVersion'),
    'Provide at least one field to change.',
  );

export type RequirementItemEdit = z.infer<typeof requirementItemEditSchema>;

/** A requirement typed by a person rather than extracted. */
export const manualRequirementSchema = z
  .object({
    title: z.string().min(1).max(ANALYSIS_LIMITS.maxTitleLength),
    statement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    category: requirementCategorySchema,
    nfrDimension: nfrDimensionSchema.optional(),
    priority: requirementPrioritySchema.default('unspecified'),
    /**
     * Optional, and its absence is recorded rather than hidden: a manual item
     * with no citation scores lower than a traced one, because it is less
     * checkable, not because a person is less trustworthy than a model.
     */
    references: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(64),
            blockId: z.string().min(1).max(64),
          })
          .strict(),
      )
      .max(ANALYSIS_LIMITS.maxReferencesPerItem)
      .default([]),
  })
  .strict()
  .refine(
    (item) => item.category !== 'non_functional' || item.nfrDimension !== undefined,
    'A non-functional requirement needs a quality dimension.',
  );

export type ManualRequirement = z.infer<typeof manualRequirementSchema>;

/* --------------------------------------------------------- history */

export const REQUIREMENT_CHANGE_SOURCES = [
  'analysis',
  'user_edit',
  'clarification_integration',
  'proposal_accepted',
  'conflict_resolution',
  'duplicate_merge',
] as const;

export type RequirementChangeSource = (typeof REQUIREMENT_CHANGE_SOURCES)[number];

/**
 * One historical version of a requirement.
 *
 * Written before every change, by anything that changes one. The point is not
 * archaeology for its own sake — it is that "the AI rewrote my requirement" has
 * to be answerable with the previous wording in hand, and that an approved
 * baseline naming an item must remain readable against what that item said.
 */
export const requirementVersionSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    version: z.number().int().nonnegative(),
    title: z.string().min(1).max(ANALYSIS_LIMITS.maxTitleLength),
    statement: z.string().min(1).max(ANALYSIS_LIMITS.maxDescriptionLength),
    category: requirementCategorySchema,
    priority: requirementPrioritySchema,
    status: requirementStatusSchema,
    references: z.array(traceabilityLinkSchema).max(ANALYSIS_LIMITS.maxReferencesPerItem),
    changedBy: z.enum(REQUIREMENT_CHANGE_SOURCES),
    /** Plain language. Shown in the history a reviewer can read. */
    reason: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    /** The clarification responsible, when one was. */
    clarificationKey: z.string().max(16).optional(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type RequirementVersion = z.infer<typeof requirementVersionSchema>;

/** Formats a sequence number as the key a person sees. */
export function requirementKey(sequence: number): string {
  return `REQ-${String(sequence).padStart(3, '0')}`;
}

/**
 * Review order: worst evidence first, then by category, then by key.
 *
 * Evidence-derived confidence is what orders this, not the model's opinion. The
 * items most likely to be wrong are the ones a reviewer should see first.
 */
export function compareForReview(a: RequirementItem, b: RequirementItem): number {
  const byScore = a.evidenceConfidence.score - b.evidenceConfidence.score;

  if (Math.abs(byScore) > 0.0001) {
    return byScore;
  }

  return a.key.localeCompare(b.key);
}
