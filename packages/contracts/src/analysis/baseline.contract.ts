import { z } from 'zod';

import { ANALYSIS_LIMITS } from './analysis-limits';

/**
 * The reviewed set of requirements at a point in time.
 *
 * What a client would sign, and therefore the artefact every guarantee in this
 * phase exists to protect. Three of them matter most.
 *
 * **A baseline states how complete it is, and the number is earned.** Coverage
 * counts evidence blocks that were actually accounted for; alignment measures
 * traceability, evidence quality and unresolved work. Neither is allowed to
 * reach 100% merely because generation finished — a run that produced output
 * and left six open conflicts has not aligned with anything.
 *
 * **Approval is gated by things that can be enumerated.** Blockers are computed
 * from stored data, each names what to do about it, and approval with any of
 * them present is refused. "The reviewer should have noticed" is not a control.
 *
 * **Versions supersede; they never overwrite.** An approved baseline whose
 * sources have changed becomes `outdated` and stays readable. What was signed
 * remains what was signed.
 */

export const BASELINE_STATUSES = [
  /** Produced by a run, not yet reviewed. */
  'draft',
  /** Someone is working through it. */
  'in_review',
  /** Signed off. Immutable from here. */
  'approved',
  /**
   * Approved, but the sources have moved on since.
   *
   * Reachable only from `approved`, and it does not change a single
   * requirement: the baseline still says what it said when it was approved. The
   * status is a statement about the world, not about the document.
   */
  'outdated',
  /** Replaced by a later version. */
  'superseded',
] as const;

export type BaselineStatus = (typeof BASELINE_STATUSES)[number];
export const baselineStatusSchema = z.enum(BASELINE_STATUSES);

export const BASELINE_STATUS_LABELS: Readonly<Record<BaselineStatus, string>> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  outdated: 'Out of date',
  superseded: 'Superseded',
};

export const BASELINE_TRANSITIONS: Readonly<Record<BaselineStatus, readonly BaselineStatus[]>> = {
  draft: ['in_review', 'superseded'],
  in_review: ['draft', 'approved', 'superseded'],
  approved: ['outdated', 'superseded'],
  outdated: ['superseded'],
  superseded: [],
};

export function canTransitionBaseline(from: BaselineStatus, to: BaselineStatus): boolean {
  return from === to || (BASELINE_TRANSITIONS[from]?.includes(to) ?? false);
}

/* ---------------------------------------------------------- coverage */

/**
 * How much of the evidence was accounted for.
 *
 * Not "how many requirements were found" — that number can be inflated by a
 * model that splits one sentence into four. This counts *blocks of reviewed
 * source content that received a disposition*: covered, judged not a
 * requirement, or duplicated. A block whose chunk failed is `notAnalysed`, and
 * it is a real gap.
 */
export const coverageSchema = z
  .object({
    totalBlocks: z.number().int().nonnegative(),
    coveredBlocks: z.number().int().nonnegative(),
    /** Read and judged to state no requirement, each with a recorded reason. */
    noRequirementBlocks: z.number().int().nonnegative(),
    duplicateContentBlocks: z.number().int().nonnegative(),
    /** Never analysed, because their chunk failed. The honest gap. */
    notAnalysedBlocks: z.number().int().nonnegative(),
    /** 0–1: everything except `notAnalysed`, over the total. */
    ratio: z.number().min(0).max(1),
    /** Per-source, so a reviewer can see *which* document was skipped. */
    bySource: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(64),
            sourceName: z.string().min(1).max(300),
            totalBlocks: z.number().int().nonnegative(),
            accountedBlocks: z.number().int().nonnegative(),
            ratio: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type Coverage = z.infer<typeof coverageSchema>;

/* --------------------------------------------------------- alignment */

/**
 * How well the baseline reflects what the documents actually said.
 *
 * Four deterministic components, each independently explainable, and a
 * completeness gate on top. **A generated baseline does not get to claim
 * alignment for having been generated**: `isComplete` is false, and the score is
 * capped, while any of these is true — a block was never analysed, an item has
 * no traceable evidence, a blocking conflict is open, or a blocking
 * clarification is unanswered.
 *
 * The cap matters more than the score. A number near 100 next to six unresolved
 * conflicts is not an optimistic estimate; it is a false statement in a document
 * a client is being asked to trust.
 */
export const alignmentSchema = z
  .object({
    /** Fraction of items with at least one verified source reference. */
    traceability: z.number().min(0).max(1),
    /** Mean evidence-derived confidence across the baseline's items. */
    evidenceQuality: z.number().min(0).max(1),
    /** Fraction of findings that are no longer open. */
    findingResolution: z.number().min(0).max(1),
    /** Fraction of clarifications answered, integrated or dismissed. */
    clarificationResolution: z.number().min(0).max(1),
    /** Weighted combination, after the completeness cap. */
    overall: z.number().min(0).max(1),
    /**
     * Whether everything that could be settled has been.
     *
     * The only condition under which `overall` may reach 1.
     */
    isComplete: z.boolean(),
    /** Why it is not complete, in plain language. Empty when it is. */
    incompleteReasons: z.array(z.string().max(300)).max(20),
  })
  .strict();

export type Alignment = z.infer<typeof alignmentSchema>;

/** Above this, alignment cannot go while anything is unresolved. */
export const INCOMPLETE_ALIGNMENT_CAP = 0.85;

/* ---------------------------------------------------------- blockers */

export const BLOCKER_KINDS = [
  /** An open conflict marked blocking. */
  'blocking_conflict',
  /** A blocking clarification with no answer. */
  'unanswered_clarification',
  /** A requirement with no source reference at all. */
  'untraceable_requirement',
  /** A requirement whose evidence score is in the unsupported band. */
  'unsupported_requirement',
  /** A requirement citing a source that does not exist in this project. */
  'hallucinated_reference',
  /** Reviewed content that no chunk ever analysed. */
  'unanalysed_content',
  /** A duplicate group nobody has decided about. */
  'open_duplicate',
  /** A gap that stops a requirement being implementable. */
  'blocking_gap',
  /** The baseline has no requirements in it. */
  'empty_baseline',
] as const;

export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export const blockerKindSchema = z.enum(BLOCKER_KINDS);

/**
 * One reason a baseline may not be approved yet.
 *
 * Every blocker names what to do about it. A gate that says "not allowed"
 * without saying why is a gate people learn to route around.
 */
export const approvalBlockerSchema = z
  .object({
    kind: blockerKindSchema,
    /** How many of this kind. Shown as "3 requirements have no source". */
    count: z.number().int().positive(),
    summary: z.string().min(1).max(300),
    /** What the reviewer should do. Always actionable. */
    action: z.string().min(1).max(300),
    /** The affected records, so the UI can link straight to them. */
    itemIds: z.array(z.string().max(64)).max(100),
    findingIds: z.array(z.string().max(64)).max(100),
  })
  .strict();

export type ApprovalBlocker = z.infer<typeof approvalBlockerSchema>;

/* --------------------------------------------------------- baseline */

export const OUTDATED_REASONS = [
  'source_added',
  'source_removed',
  'source_content_changed',
  'requirement_edited',
  'newer_analysis',
] as const;

export type OutdatedReason = (typeof OUTDATED_REASONS)[number];
export const outdatedReasonSchema = z.enum(OUTDATED_REASONS);

export const OUTDATED_REASON_MESSAGES: Readonly<Record<OutdatedReason, string>> = {
  source_added: 'A document was added after this baseline was approved.',
  source_removed: 'A document was removed after this baseline was approved.',
  source_content_changed: 'A document’s reviewed content changed after this baseline was approved.',
  requirement_edited: 'A requirement was edited after this baseline was approved.',
  newer_analysis: 'A newer analysis has been run.',
};

export const baselineSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    /** 1-based, per project. Shown as "Baseline v2". */
    version: z.number().int().positive(),
    status: baselineStatusSchema,
    itemIds: z.array(z.string().max(64)).max(ANALYSIS_LIMITS.maxRequirementItems),
    itemCount: z.number().int().nonnegative(),
    /** Per category, for the summary a reviewer sees first. */
    categoryCounts: z.record(z.string(), z.number().int().nonnegative()),
    coverage: coverageSchema,
    alignment: alignmentSchema,
    blockers: z.array(approvalBlockerSchema).max(20),
    /**
     * The digest of reviewed content this baseline was built from.
     *
     * Compared against the project's current digest to decide whether an
     * approved baseline has gone out of date. Cheap, exact, and it does not
     * require re-reading a single document.
     */
    contentDigest: z.string().min(1).max(128),
    approvedAt: z.iso.datetime().optional(),
    /** Free text the approver typed. Not a signature; a record. */
    approvalNote: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    outdatedReason: outdatedReasonSchema.optional(),
    outdatedAt: z.iso.datetime().optional(),
    supersededByVersion: z.number().int().positive().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /**
     * Optimistic concurrency for the record.
     *
     * Named apart from `version` because that one is the baseline's own,
     * user-facing version number — "Baseline v2" — and conflating a document
     * version with a row revision is how one silently becomes the other.
     */
    recordVersion: z.number().int().nonnegative(),
  })
  .strict();

export type Baseline = z.infer<typeof baselineSchema>;

export const approveBaselineSchema = z
  .object({
    note: z.string().max(ANALYSIS_LIMITS.maxExplanationLength).optional(),
    /**
     * Explicit acknowledgement that this is a self-hosted AI-assisted draft.
     *
     * Required, and deliberately not a default. The model that produced this is
     * a small one running on the operator's own hardware; the person approving
     * has to affirm they have read what they are approving, because the
     * application cannot check that for them.
     */
    acknowledgedAiAssistance: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ApproveBaseline = z.infer<typeof approveBaselineSchema>;

export function canApprove(baseline: Pick<Baseline, 'status' | 'blockers' | 'itemCount'>): boolean {
  return (
    (baseline.status === 'draft' || baseline.status === 'in_review') &&
    baseline.blockers.length === 0 &&
    baseline.itemCount > 0
  );
}

/**
 * The sentence shown wherever a baseline is displayed.
 *
 * Not decoration. The reader has to know a language model drafted this and a
 * person is accountable for it, at the moment they are looking at it — not in a
 * footer they scrolled past.
 */
export const BASELINE_AI_NOTICE =
  'Drafted by a self-hosted AI model from your documents, then reviewed by a person. Every requirement links to the text it came from.';
