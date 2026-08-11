import { z } from 'zod';

/**
 * Acceptance Criteria — Document 3.
 *
 * ## What this document is, and what it is not
 *
 * It states the **observable conditions for accepting the approved scope**. One
 * criterion is one thing a reader could watch happen and agree had happened.
 *
 * It is **not** a test-case document. No steps, no test data, no expected
 * screenshots, no automation. The difference is not stylistic: a test case
 * describes how somebody would check, and belongs to whoever tests; a criterion
 * describes what has to be true, and belongs to the client and the contract. A
 * document that quietly becomes the first is one that nobody in the commercial
 * conversation can read, and it stops being an acceptance standard.
 *
 * Detailed procedures appear only where a requirement explicitly asks for them —
 * `requiresProcedure` records that, and it comes from the requirement's own words.
 *
 * ## Given / When / Then is available, not compulsory
 *
 * A criterion may carry a precondition, an action and an outcome. Many do, and
 * the shape reads well for anything a user does. But a data-retention rule, a
 * batch job or a reporting figure is distorted by being forced into "Given a
 * user...", and a distorted criterion is a worse criterion. So `given` is
 * optional, `when` is optional, and `then` — the observable outcome — is the only
 * part every criterion must have. `isGherkinShaped` reports which form a criterion
 * took rather than enforcing one.
 *
 * ## What a model may not put in here
 *
 * Thresholds. "Within two seconds", "99.9% available", "supports 500 concurrent
 * users", "WCAG 2.1 AA", "AES-256", "retained for seven years" — every one of
 * those is a commitment, and a text generator inventing one creates an obligation
 * nobody agreed to. `UNSTATED_THRESHOLD_PATTERNS` finds them, and a criterion
 * carrying a figure that is not in the approved evidence is a BLOCKING finding
 * rather than a warning, because warnings get acknowledged and shipped.
 */

/* ------------------------------------------------------------- criterion */

/** How specific the observable outcome is, deterministically judged. */
export const CRITERION_STATUSES = ['DRAFT', 'ACCEPTED', 'EXCLUDED', 'SUPERSEDED'] as const;

export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export const CRITERION_STATUS_LABELS: Readonly<Record<CriterionStatus, string>> = {
  DRAFT: 'Draft',
  ACCEPTED: 'Agreed',
  EXCLUDED: 'Deliberately left out',
  SUPERSEDED: 'Replaced',
};

/**
 * The classes of condition a criterion can express.
 *
 * Recorded rather than inferred, because a reader scanning fifty criteria for the
 * permission rules should be able to find them, and because coverage is more
 * useful when it can say *what kind* of condition a feature has and has not got.
 */
export const CRITERION_ASPECTS = [
  /** Something a user does, and what follows. */
  'BEHAVIOUR',
  /** A rule about what is allowed. */
  'VALIDATION',
  /** Who may do it. */
  'PERMISSION',
  /** What is stored, kept or changed. */
  'DATA',
  /** Behaviour at a boundary with another system. */
  'INTEGRATION',
  /** A stated non-functional condition — only ever from explicit evidence. */
  'NON_FUNCTIONAL',
] as const;

export type CriterionAspect = (typeof CRITERION_ASPECTS)[number];

export const CRITERION_ASPECT_LABELS: Readonly<Record<CriterionAspect, string>> = {
  BEHAVIOUR: 'Behaviour',
  VALIDATION: 'Validation rule',
  PERMISSION: 'Permission',
  DATA: 'Data',
  INTEGRATION: 'Integration',
  NON_FUNCTIONAL: 'Stated non-functional condition',
};

export const acceptanceCriterionSchema = z
  .object({
    /** Human-facing identifier, `AC-001`. Stable for the life of the document. */
    criterionKey: z.string().regex(/^AC-\d{3,5}$/, 'An acceptance criterion is keyed AC-001'),
    /** Requirements this condition comes from. At least one, unless user-defined. */
    requirementIds: z.array(z.string().max(64)).max(40),
    /** Feature Listing rows this condition applies to. */
    featureIds: z.array(z.string().max(64)).max(40),
    module: z.string().max(200),
    submodule: z.string().max(200),
    /** Blank for anything with no interface — an API, a job, a rule. */
    screen: z.string().max(200),
    /** Whose condition this is, when the requirement names a role. */
    actor: z.string().max(120),
    aspect: z.enum(CRITERION_ASPECTS),

    /* The condition itself. Only `then` is compulsory. */
    /** Precondition, where one is genuinely necessary. */
    given: z.string().max(1_000),
    /** The action or trigger. Absent for a standing rule. */
    when: z.string().max(1_000),
    /** The observable outcome. This is the criterion. */
    then: z.string().min(1).max(2_000),

    /** The business or validation rule behind it, in the client's terms. */
    rule: z.string().max(1_000),
    /**
     * True only when the requirement itself asks for a procedure.
     *
     * The one door through which step-by-step detail may enter this document, and
     * it is opened by the requirement, never by a model.
     */
    requiresProcedure: z.boolean(),
    status: z.enum(CRITERION_STATUSES),
    notes: z.string().max(1_000),
  })
  .strict();

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

/** Which of the two forms this criterion took. Reported, never enforced. */
export function isGherkinShaped(criterion: Pick<AcceptanceCriterion, 'given' | 'when'>): boolean {
  return criterion.given.trim().length > 0 && criterion.when.trim().length > 0;
}

/**
 * The criterion as a reader sees it.
 *
 * Given/When/Then when the criterion has that shape, a sentence when it does not.
 * One function, so the table, the clipboard and the export cannot render it three
 * ways.
 */
export function criterionText(criterion: AcceptanceCriterion): string {
  const parts: string[] = [];

  if (criterion.given.trim().length > 0) {
    parts.push(`Given ${criterion.given.trim()}`);
  }

  if (criterion.when.trim().length > 0) {
    parts.push(`When ${criterion.when.trim()}`);
  }

  parts.push(parts.length > 0 ? `Then ${criterion.then.trim()}` : criterion.then.trim());

  return parts.join('\n');
}

/**
 * Whether two criteria say the same thing.
 *
 * Compared on the normalised outcome and the feature it applies to. Two features
 * legitimately share an outcome — "the record is saved" is true in many places —
 * so the outcome alone is not a duplicate; the same outcome on the same feature
 * is.
 */
export function criterionFingerprint(criterion: AcceptanceCriterion): string {
  const normalise = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  return [
    [...criterion.featureIds].sort().join(','),
    normalise(criterion.given),
    normalise(criterion.when),
    normalise(criterion.then),
  ].join('|');
}

/* ------------------------------------------------- unstated thresholds */

/**
 * The shapes of a commitment nobody agreed to.
 *
 * Each pattern matches a *quantity or standard* that only means something if
 * somebody signed up to it. The check is: does this figure appear in the approved
 * evidence? If it does, the criterion is quoting the client. If it does not,
 * something invented it, and inventing a service level is the most expensive
 * mistake this document can make.
 */
export const UNSTATED_THRESHOLD_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly kind: string;
}[] = [
  { pattern: /\b\d+(\.\d+)?\s*(ms|milliseconds?|seconds?|minutes?)\b/i, kind: 'a response time' },
  { pattern: /\bwithin\s+\d+\s*\w+/i, kind: 'a time limit' },
  {
    pattern: /\b\d{1,3}(\.\d+)?\s*%\s*(uptime|availability|available)/i,
    kind: 'an availability figure',
  },
  { pattern: /\b\d+\s*(concurrent|simultaneous)\b/i, kind: 'a concurrency target' },
  {
    pattern: /\b\d+\s*(requests?|transactions?|users?)\s*(per|\/)\s*(second|minute|hour|day)/i,
    kind: 'a throughput target',
  },
  {
    pattern: /\bWCAG\b|\bAA\b\s*(compliance|compliant)|\bsection\s*508\b/i,
    kind: 'an accessibility standard',
  },
  {
    pattern: /\bAES[- ]?\d{3}\b|\bTLS\s*1\.\d\b|\bSHA[- ]?\d{3}\b|\bRSA[- ]?\d{4}\b/i,
    kind: 'an encryption standard',
  },
  {
    pattern: /\bGDPR\b|\bHIPAA\b|\bSOC\s*2\b|\bPCI[- ]?DSS\b|\bISO\s*\d{4,5}\b/i,
    kind: 'a compliance regime',
  },
  {
    pattern: /\bretain(ed|ing)?\s+(for\s+)?\d+\s*(days?|months?|years?)/i,
    kind: 'a retention period',
  },
  { pattern: /\b(chrome|firefox|safari|edge)\b.{0,20}\b\d+\+?/i, kind: 'a browser version' },
  { pattern: /\b(iOS|Android)\s*\d+(\.\d+)?\+?/i, kind: 'a device or OS version' },
  { pattern: /\b\d+\s*(nines|9s)\b/i, kind: 'an availability figure' },
];

/**
 * Thresholds in this text that the approved evidence does not contain.
 *
 * `evidence` is the concatenated approved requirement text. A figure found in
 * both is a quotation and passes; a figure found only in the criterion was
 * invented. Comparison is on the matched substring, normalised for spacing, so
 * "within 2 seconds" matches a requirement saying "within 2 seconds" but not one
 * saying "within 5 seconds".
 */
export function unstatedThresholds(
  text: string,
  evidence: string,
): readonly { readonly kind: string; readonly quote: string }[] {
  const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ');
  const haystack = normalise(evidence);
  const found: { kind: string; quote: string }[] = [];

  for (const { pattern, kind } of UNSTATED_THRESHOLD_PATTERNS) {
    const match = pattern.exec(text);

    if (match && !haystack.includes(normalise(match[0]))) {
      found.push({ kind, quote: match[0] });
    }
  }

  /*
   * Several patterns catch the same figure — "within 2 seconds" matches both the
   * time-limit shape and the duration shape. Reporting one invented commitment
   * twice trains a reader to skim the list, so the widest quote wins and the
   * narrower ones inside it are dropped.
   */
  return found.filter(
    (finding) =>
      !found.some(
        (other) =>
          other !== finding &&
          normalise(other.quote).includes(normalise(finding.quote)) &&
          other.quote.length > finding.quote.length,
      ),
  );
}

/* ------------------------------------------------------------- coverage */

/**
 * What is covered by acceptance criteria, and what is not.
 *
 * Counted from disposition, exactly as Feature Listing coverage is: a requirement
 * or feature is covered when a criterion cites it, dispositioned when somebody
 * deliberately excluded it, and unaddressed otherwise. Nothing here rounds up to
 * a hundred per cent, and `complete` is a conclusion rather than a default.
 */
export const criteriaCoverageSchema = z
  .object({
    applicableRequirements: z.number().int().nonnegative(),
    coveredRequirements: z.number().int().nonnegative(),
    excludedRequirements: z.number().int().nonnegative(),
    uncoveredRequirementIds: z.array(z.string().max(64)).max(500),
    applicableFeatures: z.number().int().nonnegative(),
    coveredFeatures: z.number().int().nonnegative(),
    excludedFeatures: z.number().int().nonnegative(),
    uncoveredFeatureIds: z.array(z.string().max(64)).max(500),
    /** Criteria that cite nothing at all. */
    unsupportedCriterionKeys: z.array(z.string().max(64)).max(500),
    complete: z.boolean(),
  })
  .strict();

export type CriteriaCoverage = z.infer<typeof criteriaCoverageSchema>;

export function calculateCriteriaCoverage(input: {
  readonly applicableRequirementIds: readonly string[];
  readonly applicableFeatureIds: readonly string[];
  readonly criteria: readonly {
    readonly criterionKey: string;
    readonly requirementIds: readonly string[];
    readonly featureIds: readonly string[];
    readonly status: CriterionStatus;
  }[];
  readonly excludedRequirementIds: readonly string[];
  readonly excludedFeatureIds: readonly string[];
}): CriteriaCoverage {
  /* An excluded criterion covers nothing — it is a decision not to state one. */
  const live = input.criteria.filter((criterion) => criterion.status !== 'EXCLUDED');

  const citedRequirements = new Set(live.flatMap((criterion) => criterion.requirementIds));
  const citedFeatures = new Set(live.flatMap((criterion) => criterion.featureIds));
  const excludedRequirements = new Set(input.excludedRequirementIds);
  const excludedFeatures = new Set(input.excludedFeatureIds);

  const uncoveredRequirementIds = input.applicableRequirementIds.filter(
    (id) => !citedRequirements.has(id) && !excludedRequirements.has(id),
  );
  const uncoveredFeatureIds = input.applicableFeatureIds.filter(
    (id) => !citedFeatures.has(id) && !excludedFeatures.has(id),
  );

  const unsupportedCriterionKeys = live
    .filter(
      (criterion) => criterion.requirementIds.length === 0 && criterion.featureIds.length === 0,
    )
    .map((criterion) => criterion.criterionKey);

  return {
    applicableRequirements: input.applicableRequirementIds.length,
    coveredRequirements: input.applicableRequirementIds.filter((id) => citedRequirements.has(id))
      .length,
    excludedRequirements: input.applicableRequirementIds.filter((id) =>
      excludedRequirements.has(id),
    ).length,
    uncoveredRequirementIds,
    applicableFeatures: input.applicableFeatureIds.length,
    coveredFeatures: input.applicableFeatureIds.filter((id) => citedFeatures.has(id)).length,
    excludedFeatures: input.applicableFeatureIds.filter((id) => excludedFeatures.has(id)).length,
    uncoveredFeatureIds,
    unsupportedCriterionKeys,
    complete:
      uncoveredRequirementIds.length === 0 &&
      uncoveredFeatureIds.length === 0 &&
      unsupportedCriterionKeys.length === 0,
  };
}

/** The next free `AC-nnn`, given what exists. */
export function nextCriterionKey(existing: readonly string[]): string {
  const highest = existing.reduce((best, key) => {
    const match = /^AC-(\d{3,5})$/.exec(key);

    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);

  return `AC-${String(highest + 1).padStart(3, '0')}`;
}
