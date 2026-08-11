import { z } from 'zod';

/**
 * Assumptions — Document 4.
 *
 * ## The rule this document exists to enforce
 *
 * **Missing information does not become an assumption.** Not automatically, not
 * as a convenience, not when it would unblock something.
 *
 * The temptation is obvious and the failure is expensive. A requirement does not
 * say which payment currency, so the generator writes "we assume GBP", the
 * assumption reads as agreed because it is in an approved document, and eighteen
 * weeks later somebody discovers the client always meant euros. The gap was real
 * information that needed asking about; turning it into a sentence made it look
 * answered.
 *
 * So the two things stay apart:
 *
 * - an **open question** is information that is missing and still needs an answer.
 *   It stays in Phase 4's clarification workflow, and a blocking one stays
 *   blocking. Nothing in this document clears it.
 * - an **assumption** is a specific proposition somebody has decided to treat as
 *   true, in the knowledge that it might not be, with their name against it.
 *
 * `PROVENANCE` is how the second is enforced. Every assumption has to answer "why
 * are we allowed to call this an assumption?", and the permitted answers all
 * involve a person: the client said it, the user said it, a clarification was
 * confirmed, an approved estimate or an accepted technical decision rests on it.
 *
 * ## A model may propose; only a person may confirm
 *
 * A model reading the requirements can be genuinely useful here — it notices what
 * a plan is quietly resting on. So it may produce **candidates**, and candidates
 * are visibly candidates: `DRAFT`, provenance `MODEL_SUGGESTED`, and excluded from
 * an approved document by `entersApprovedDocument`.
 *
 * What a model may not do is set `status`, set `confirmedBy`, or write any of the
 * authoritative provenance values. The generation schema has no field for them —
 * `assumptionCandidateSchema` is the whole of what a model may return — so this is
 * not a rule the model is asked to follow. It is a shape it cannot express.
 */

/* ------------------------------------------------------------- category */

export const ASSUMPTION_CATEGORIES = [
  'BUSINESS',
  'FUNCTIONAL',
  'TECHNICAL',
  'INTEGRATION',
  'DATA',
  'ENVIRONMENT',
  'DEPLOYMENT',
  'CLIENT',
  'DELIVERY',
  'ESTIMATION',
  'COMPLIANCE',
  'OTHER',
] as const;

export type AssumptionCategory = (typeof ASSUMPTION_CATEGORIES)[number];
export const assumptionCategorySchema = z.enum(ASSUMPTION_CATEGORIES);

export const ASSUMPTION_CATEGORY_LABELS: Readonly<Record<AssumptionCategory, string>> = {
  BUSINESS: 'Business',
  FUNCTIONAL: 'Functional',
  TECHNICAL: 'Technical',
  INTEGRATION: 'Integration',
  DATA: 'Data',
  ENVIRONMENT: 'Environment',
  DEPLOYMENT: 'Deployment',
  CLIENT: 'Client',
  DELIVERY: 'Delivery',
  ESTIMATION: 'Estimation',
  COMPLIANCE: 'Compliance',
  OTHER: 'Other',
};

/* ----------------------------------------------------------- provenance */

/**
 * Why this may be called an assumption.
 *
 * The first five are authoritative: each one names a person or an approved
 * artifact. `MODEL_SUGGESTED` is not authoritative and is the only value a
 * generation run can lead to — it means "something noticed this might be an
 * assumption", which is a useful thing to be told and not a basis for a contract.
 */
export const ASSUMPTION_PROVENANCE = [
  'CLIENT_STATED',
  'USER_STATED',
  'CONFIRMED_CLARIFICATION',
  'APPROVED_ESTIMATION_ASSUMPTION',
  'APPROVED_TECHNICAL_ASSUMPTION',
  'MODEL_SUGGESTED',
] as const;

export type AssumptionProvenance = (typeof ASSUMPTION_PROVENANCE)[number];
export const assumptionProvenanceSchema = z.enum(ASSUMPTION_PROVENANCE);

export const PROVENANCE_LABELS: Readonly<Record<AssumptionProvenance, string>> = {
  CLIENT_STATED: 'The client stated this',
  USER_STATED: 'You stated this',
  CONFIRMED_CLARIFICATION: 'Confirmed in a clarification',
  APPROVED_ESTIMATION_ASSUMPTION: 'The approved estimate rests on it',
  APPROVED_TECHNICAL_ASSUMPTION: 'An accepted technical decision rests on it',
  MODEL_SUGGESTED: 'Suggested for your consideration — not yet an assumption',
};

/** Provenance a person or an approved artifact stands behind. */
export const AUTHORITATIVE_PROVENANCE: readonly AssumptionProvenance[] = [
  'CLIENT_STATED',
  'USER_STATED',
  'CONFIRMED_CLARIFICATION',
  'APPROVED_ESTIMATION_ASSUMPTION',
  'APPROVED_TECHNICAL_ASSUMPTION',
];

export function isAuthoritativeProvenance(provenance: AssumptionProvenance): boolean {
  return AUTHORITATIVE_PROVENANCE.includes(provenance);
}

/* --------------------------------------------------------------- status */

export const ASSUMPTION_STATUSES = [
  /** Written down, nobody has stood behind it yet. Includes every candidate. */
  'DRAFT',
  /** A person has explicitly accepted it as an assumption of this project. */
  'CONFIRMED',
  /** Considered and turned down. Kept, so the decision is on the record. */
  'REJECTED',
  /** Replaced by another assumption. */
  'SUPERSEDED',
  /** Later shown to be true. */
  'VALIDATED',
  /** Later shown to be false. The interesting one. */
  'INVALIDATED',
] as const;

export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];
export const assumptionStatusSchema = z.enum(ASSUMPTION_STATUSES);

export const ASSUMPTION_STATUS_LABELS: Readonly<Record<AssumptionStatus, string>> = {
  DRAFT: 'Candidate',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  SUPERSEDED: 'Replaced',
  VALIDATED: 'Proved true',
  INVALIDATED: 'Proved false',
};

/**
 * Whether this assumption belongs in an approved Assumptions document.
 *
 * Confirmed or validated, and standing on authoritative provenance. A candidate
 * is excluded however plausible it reads, and a rejected assumption is excluded
 * while staying visible in the workflow — the record of what was turned down is
 * worth keeping.
 */
export function entersApprovedDocument(assumption: {
  readonly status: AssumptionStatus;
  readonly provenance: AssumptionProvenance;
}): boolean {
  return (
    (assumption.status === 'CONFIRMED' || assumption.status === 'VALIDATED') &&
    isAuthoritativeProvenance(assumption.provenance)
  );
}

/** The moves a person may make. `DRAFT → CONFIRMED` is the one that matters. */
export const ASSUMPTION_TRANSITIONS: Readonly<
  Record<AssumptionStatus, readonly AssumptionStatus[]>
> = {
  DRAFT: ['CONFIRMED', 'REJECTED', 'SUPERSEDED'],
  CONFIRMED: ['VALIDATED', 'INVALIDATED', 'REJECTED', 'SUPERSEDED'],
  REJECTED: ['DRAFT'],
  SUPERSEDED: [],
  VALIDATED: ['INVALIDATED', 'SUPERSEDED'],
  INVALIDATED: ['SUPERSEDED', 'DRAFT'],
};

export function canTransitionAssumption(from: AssumptionStatus, to: AssumptionStatus): boolean {
  return ASSUMPTION_TRANSITIONS[from].includes(to);
}

/* --------------------------------------------------------------- impact */

/**
 * What happens if this turns out to be false.
 *
 * Qualitative on purpose. "This would add roughly 40 hours" is a number nobody
 * calculated, and a fabricated quantity in a risk column is worse than an honest
 * adjective. `BLOCKING` means the project cannot responsibly be committed to
 * while the assumption is unresolved.
 */
export const IMPACT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'BLOCKING'] as const;

export type ImpactLevel = (typeof IMPACT_LEVELS)[number];
export const impactLevelSchema = z.enum(IMPACT_LEVELS);

export const IMPACT_LABELS: Readonly<Record<ImpactLevel, string>> = {
  LOW: 'Minor',
  MEDIUM: 'Noticeable',
  HIGH: 'Serious',
  BLOCKING: 'Would stop the plan',
};

/** What a false assumption would disturb. Named, never quantified. */
export const IMPACT_AREAS = ['SCOPE', 'ESTIMATE', 'TIMELINE', 'TECHNOLOGY', 'DEPENDENCY'] as const;

export type ImpactArea = (typeof IMPACT_AREAS)[number];

export const IMPACT_AREA_LABELS: Readonly<Record<ImpactArea, string>> = {
  SCOPE: 'what is being built',
  ESTIMATE: 'the estimate',
  TIMELINE: 'the timeline',
  TECHNOLOGY: 'the technology',
  DEPENDENCY: 'something we depend on',
};

/* ------------------------------------------------------------ assumption */

export const assumptionSchema = z
  .object({
    assumptionKey: z.string().regex(/^AS-\d{3,5}$/, 'An assumption is keyed AS-001'),
    category: assumptionCategorySchema,
    /** The proposition, stated so it could be proved wrong. */
    statement: z.string().min(1).max(2_000),
    /** Why we may call it an assumption. */
    provenance: assumptionProvenanceSchema,
    /** The evidence in the user's terms: who said it, where, when. */
    basis: z.string().max(1_000),
    status: assumptionStatusSchema,

    requirementIds: z.array(z.string().max(64)).max(40),
    featureIds: z.array(z.string().max(64)).max(40),
    technologyIds: z.array(z.string().max(64)).max(40),
    estimateUnitIds: z.array(z.string().max(64)).max(40),

    /** Who is responsible for it being true. Only ever supplied by a person. */
    owner: z.string().max(200),
    impact: impactLevelSchema,
    impactAreas: z.array(z.enum(IMPACT_AREAS)).max(5),
    /** What would happen if it were false, in words. */
    impactIfFalse: z.string().max(1_000),
    /** What would settle it. */
    validationNeeded: z.string().max(1_000),
    /** When it should be settled by, when that is known. */
    validateBy: z.string().max(200),

    /** Recorded when a person confirms. `USER`, for the reason Phase 7 gives. */
    confirmedBy: z.literal('USER').optional(),
    confirmedAt: z.string().datetime().optional(),
    /** Why it was turned down. */
    rejectedReason: z.string().max(1_000).optional(),
    notes: z.string().max(1_000),
  })
  .strict();

export type Assumption = z.infer<typeof assumptionSchema>;

/**
 * What a model is allowed to return.
 *
 * No status, no provenance, no owner, no confirmation — those are the fields that
 * make an assumption authoritative, and there is nowhere to put them. A candidate
 * is a statement, a guess at its category, what it seems to touch, and why it
 * looked like an assumption.
 */
export const assumptionCandidateSchema = z
  .object({
    statement: z.string().min(1).max(2_000),
    category: assumptionCategorySchema,
    /** Why the model thinks the plan is resting on this. */
    reasoning: z.string().max(1_000),
    /** Requirement keys it appears to relate to. Verified before storage. */
    requirementKeys: z.array(z.string().max(64)).max(20),
    impact: impactLevelSchema,
    impactAreas: z.array(z.enum(IMPACT_AREAS)).max(5),
    impactIfFalse: z.string().max(1_000),
    validationNeeded: z.string().max(1_000),
  })
  .strict();

export type AssumptionCandidate = z.infer<typeof assumptionCandidateSchema>;

/**
 * A candidate as it is stored: unmistakably not yet an assumption.
 *
 * The one place a model's output becomes a row, and every authoritative field is
 * supplied here rather than by the model.
 */
export function candidateToAssumption(
  candidate: AssumptionCandidate,
  assumptionKey: string,
  requirementIds: readonly string[],
): Assumption {
  return {
    assumptionKey,
    category: candidate.category,
    statement: candidate.statement,
    provenance: 'MODEL_SUGGESTED',
    basis: candidate.reasoning,
    status: 'DRAFT',
    requirementIds: [...requirementIds],
    featureIds: [],
    technologyIds: [],
    estimateUnitIds: [],
    owner: '',
    impact: candidate.impact,
    impactAreas: [...candidate.impactAreas],
    impactIfFalse: candidate.impactIfFalse,
    validationNeeded: candidate.validationNeeded,
    validateBy: '',
    notes: '',
  };
}

/**
 * Two confirmed assumptions that cannot both be true.
 *
 * Deliberately narrow. It catches the case that actually occurs — the same
 * proposition asserted and denied — by comparing statements that are identical
 * once a negation is removed. It does not attempt to reason about meaning, and it
 * does not guess: a checker that flagged plausible-looking pairs would train
 * people to dismiss it.
 */
export function contradictoryAssumptions(
  assumptions: readonly Pick<Assumption, 'assumptionKey' | 'statement' | 'status'>[],
): readonly (readonly [string, string])[] {
  const live = assumptions.filter((assumption) => assumption.status === 'CONFIRMED');

  /*
   * Reduce both statements to their proposition: drop the negation *and* the
   * auxiliaries it attaches to, so "will provide" and "will not provide" collapse
   * to the same words. Without dropping the auxiliary, the negated sentence keeps
   * "provide" while the plain one keeps "will provide", and the pair never matches
   * — which is the bug this comment exists to stop coming back.
   */
  const NOISE =
    /\b(will|shall|would|does|do|did|is|are|was|were|be|been|being|must|can|could|not|never|no|none|without|won't|shan't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|cannot)\b/g;

  const strip = (value: string): string =>
    value
      .toLowerCase()
      .replace(NOISE, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const negated = (value: string): boolean =>
    /\b(not|never|no|none|without|won't|shan't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|cannot)\b/i.test(
      value,
    );

  const pairs: [string, string][] = [];

  for (let index = 0; index < live.length; index += 1) {
    for (let other = index + 1; other < live.length; other += 1) {
      const left = live[index]!;
      const right = live[other]!;

      if (
        strip(left.statement) === strip(right.statement) &&
        negated(left.statement) !== negated(right.statement)
      ) {
        pairs.push([left.assumptionKey, right.assumptionKey]);
      }
    }
  }

  return pairs;
}

/** The next free `AS-nnn`. */
export function nextAssumptionKey(existing: readonly string[]): string {
  const highest = existing.reduce((best, key) => {
    const match = /^AS-(\d{3,5})$/.exec(key);

    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);

  return `AS-${String(highest + 1).padStart(3, '0')}`;
}

/* --------------------------------------------------------- write shapes */

export const confirmAssumptionSchema = z
  .object({
    /** A person is standing behind this, so they say on what basis. */
    provenance: z.enum(['CLIENT_STATED', 'USER_STATED', 'CONFIRMED_CLARIFICATION']),
    basis: z.string().min(1).max(1_000),
    owner: z.string().max(200).optional(),
    validateBy: z.string().max(200).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ConfirmAssumption = z.infer<typeof confirmAssumptionSchema>;

export const rejectAssumptionSchema = z
  .object({
    reason: z.string().min(1).max(1_000),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RejectAssumption = z.infer<typeof rejectAssumptionSchema>;

/** Recording that a confirmed assumption turned out true, or did not. */
export const settleAssumptionSchema = z
  .object({
    outcome: z.enum(['VALIDATED', 'INVALIDATED']),
    note: z.string().min(1).max(1_000),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type SettleAssumption = z.infer<typeof settleAssumptionSchema>;

/* -------------------------------------------------------------- summary */

export const assumptionSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    invalidated: z.number().int().nonnegative(),
    /** Confirmed assumptions whose failure would stop the plan. */
    blockingUnresolved: z.array(z.string().max(64)).max(200),
    byCategory: z.record(z.string().max(40), z.number().int().nonnegative()),
  })
  .strict();

export type AssumptionSummary = z.infer<typeof assumptionSummarySchema>;

export function summariseAssumptions(
  assumptions: readonly Pick<
    Assumption,
    'assumptionKey' | 'status' | 'provenance' | 'category' | 'impact'
  >[],
): AssumptionSummary {
  const byCategory: Record<string, number> = {};

  for (const assumption of assumptions) {
    if (entersApprovedDocument(assumption)) {
      byCategory[assumption.category] = (byCategory[assumption.category] ?? 0) + 1;
    }
  }

  return {
    total: assumptions.length,
    candidates: assumptions.filter((assumption) => assumption.status === 'DRAFT').length,
    confirmed: assumptions.filter((assumption) => assumption.status === 'CONFIRMED').length,
    rejected: assumptions.filter((assumption) => assumption.status === 'REJECTED').length,
    invalidated: assumptions.filter((assumption) => assumption.status === 'INVALIDATED').length,
    blockingUnresolved: assumptions
      .filter(
        (assumption) =>
          assumption.impact === 'BLOCKING' &&
          (assumption.status === 'DRAFT' || assumption.status === 'INVALIDATED'),
      )
      .map((assumption) => assumption.assumptionKey),
    byCategory,
  };
}
