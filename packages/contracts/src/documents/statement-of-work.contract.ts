import { z } from 'zod';

/**
 * Statement of Work — Document 5.
 *
 * The commercial document. It describes the agreed work, and every material claim
 * in it is quoted from something that was approved: scope from the baseline and
 * the Feature Listing, technology from the locked stack, timeline from the approved
 * estimate, assumptions from the approved Assumptions document, acceptance from the
 * approved Acceptance Criteria.
 *
 * ## It is contract-ready in structure, and it is not a contract
 *
 * The difference matters more here than anywhere else in the application. A
 * generated document that reads like a complete agreement — governing law,
 * warranty, limitation of liability, payment schedule — is the most dangerous thing
 * this system could produce, because it would be signed. Nobody asked a text
 * generator for an indemnity clause, and nobody would notice it had written one
 * until it was being relied on.
 *
 * So `PROHIBITED_LEGAL_PATTERNS` is a BLOCKING check rather than a style
 * preference, and missing commercial terms are **flagged as missing** rather than
 * filled in. "Payment terms have not been provided" is a useful sentence. An
 * invented payment schedule is a liability.
 *
 * ## Nothing about how the software gets built
 *
 * The estimate behind this document was produced with AI assistance, and the
 * implementation will be too. That is an internal matter between the delivery team
 * and its own methods, and `INTERNAL_METHODOLOGY_PATTERNS` keeps it out: no
 * "AI-assisted development", no model names, no productivity multipliers, no
 * confidence figures. A client reading that the estimate came from a language
 * model would reasonably ask what they are paying for, and answering that question
 * is a commercial decision for a person, not a default of the generator.
 *
 * ## Timeline language follows the estimate, exactly
 *
 * If Phase 6 scheduled relative to an unknown start, the SOW says "approximately N
 * working weeks following commencement" and contains no calendar date. If Phase 6
 * has a fixed deadline, that exact date appears. If the approved estimate was
 * accepted at HIGH_RISK, the SOW states the approved timeline and the risk — it
 * does not quietly substitute a safer date, which would be the application
 * deciding a commercial question on somebody's behalf.
 */

/* -------------------------------------------------------------- sections */

/**
 * The section template.
 *
 * `required` sections must be present and non-empty before approval. The rest
 * appear when the evidence supports them and are omitted with a reason when it
 * does not — an empty heading with boilerplate under it is how a document stops
 * being read.
 */
export const SOW_SECTIONS = [
  { key: 'project-overview', title: 'Project Overview', order: 1, required: true },
  /*
   * Not required. If the approved requirements state no business objective, this
   * document cannot state one either — inventing a purpose for somebody's project
   * is exactly what the rest of this file exists to prevent. The section is omitted
   * with a reason, and a reviewer can write it themselves.
   */
  { key: 'objective', title: 'Project Objective', order: 2, required: false },
  { key: 'scope-of-work', title: 'Scope of Work', order: 3, required: true },
  { key: 'functional-scope', title: 'Functional Scope', order: 4, required: true },
  { key: 'deliverables', title: 'Deliverables', order: 5, required: true },
  { key: 'out-of-scope', title: 'Explicitly Out of Scope', order: 6, required: false },
  { key: 'technology', title: 'Technology Stack', order: 7, required: true },
  { key: 'roles', title: 'Roles and Responsibilities', order: 8, required: true },
  { key: 'approach', title: 'Implementation Approach', order: 9, required: false },
  { key: 'milestones', title: 'Milestones and Delivery Structure', order: 10, required: true },
  { key: 'timeline', title: 'Timeline', order: 11, required: true },
  { key: 'client-dependencies', title: 'Client Dependencies', order: 12, required: false },
  { key: 'constraints', title: 'Constraints', order: 13, required: false },
  { key: 'assumptions', title: 'Assumptions', order: 14, required: false },
  { key: 'acceptance', title: 'Acceptance Process', order: 15, required: true },
  { key: 'change-management', title: 'Change and Scope Management', order: 16, required: true },
  { key: 'commercial-terms', title: 'Commercial and Legal Terms', order: 17, required: false },
  { key: 'sign-off', title: 'Sign-off', order: 18, required: false },
] as const;

export type SowSectionKey = (typeof SOW_SECTIONS)[number]['key'];

export const SOW_SECTION_KEYS: readonly SowSectionKey[] = SOW_SECTIONS.map(
  (section) => section.key,
);

export const REQUIRED_SOW_SECTION_KEYS: readonly SowSectionKey[] = SOW_SECTIONS.filter(
  (section) => section.required,
).map((section) => section.key);

/**
 * Sections a model may write prose for.
 *
 * Not `technology`, `timeline`, `milestones` or `assumptions`: those are
 * transcriptions of approved artifacts, and the application composes them so that
 * no rewording can change a version number, a date or an assumption's status. A
 * model asked to "improve" the technology section would produce something
 * plausible, and plausible is precisely the failure mode.
 */
export const MODEL_WRITABLE_SOW_SECTIONS: readonly SowSectionKey[] = [
  'project-overview',
  'objective',
  'scope-of-work',
  'functional-scope',
  'deliverables',
  'out-of-scope',
  'roles',
  'approach',
  'client-dependencies',
  'constraints',
  'acceptance',
  'change-management',
];

export function isModelWritableSowSection(key: string): boolean {
  return (MODEL_WRITABLE_SOW_SECTIONS as readonly string[]).includes(key);
}

/* -------------------------------------------------------- legal boundary */

/**
 * Contractual language nobody in this system is entitled to write.
 *
 * Each of these creates or limits a legal obligation. If the user supplies terms,
 * they are recorded as supplied; if they do not, the document says they are
 * outstanding. There is no third option where the generator makes something up.
 */
export const PROHIBITED_LEGAL_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly term: string;
}[] = [
  { pattern: /\bgoverning law\b|\bgoverned by the laws\b/i, term: 'a governing-law clause' },
  { pattern: /\bexclusive jurisdiction\b|\bcourts of\b/i, term: 'a jurisdiction clause' },
  { pattern: /\bindemnif(y|ies|ication)\b|\bhold harmless\b/i, term: 'an indemnity' },
  {
    pattern: /\bwarrant(y|ies|ed|s)\b|\bmerchantability\b|\bfit(ness)? for a particular purpose\b/i,
    term: 'a warranty',
  },
  {
    pattern: /\blimitation of liability\b|\bliability (is|shall be) (limited|capped)\b/i,
    term: 'a liability limitation',
  },
  {
    pattern:
      /\bpayment (terms|schedule)\b|\bnet\s*\d{2}\b|\b\d+%\s*(upfront|on signing|upon delivery)\b/i,
    term: 'payment terms',
  },
  { pattern: /\b(penalt(y|ies)|liquidated damages)\b/i, term: 'a penalty clause' },
  {
    pattern: /\bintellectual property (shall|will) (transfer|vest)\b|\bassigns? all rights\b/i,
    term: 'an IP-transfer clause',
  },
  {
    pattern: /\bservice (level )?credits?\b|\bSLA\b.{0,20}\b(credit|refund)/i,
    term: 'SLA credits',
  },
  {
    pattern: /\btermination (for convenience|clause)\b|\bmay terminate (this|the) agreement\b/i,
    term: 'a termination clause',
  },
  { pattern: /\b(hourly|day) rate\b|\b(£|\$|€)\s?\d/i, term: 'a price or rate' },
  { pattern: /\bchange order fee\b/i, term: 'a change-order fee' },
];

export function prohibitedLegalTerms(text: string): readonly string[] {
  return PROHIBITED_LEGAL_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ term }) => term,
  );
}

/** Commercial terms a real SOW needs, which this application cannot supply. */
/**
 * Commercial terms a real SOW needs, which this application cannot supply.
 *
 * Worded as categories rather than as clause names on purpose. "Contractual and
 * legal provisions" says what is missing; writing "governing law, liability and
 * warranty" would put clause language into the document, which is the very thing
 * `PROHIBITED_LEGAL_PATTERNS` exists to catch — and a checker that had to exempt
 * its own text would be a checker with a hole in it.
 */
export const OUTSTANDING_COMMERCIAL_TERMS: readonly string[] = [
  'Pricing, invoicing and commercial arrangements',
  'Contractual and legal provisions, to be agreed with your own advisers',
  'Ownership and licensing of the delivered software',
  'Arrangements for support after delivery',
];

/* -------------------------------------------------- internal methodology */

/**
 * How the work gets done internally, which is not the client's document.
 *
 * A BLOCKING check. Not because the practice is embarrassing, but because
 * disclosing it is a commercial decision with consequences — and a decision the
 * user makes deliberately, if they ever do, rather than one a prompt makes for
 * them by leaving a word in.
 */
export const INTERNAL_METHODOLOGY_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly term: string;
}[] = [
  { pattern: /\bvibe cod(ing|ed)\b/i, term: 'vibe coding' },
  {
    pattern: /\bAI[- ]assisted (development|implementation|coding)\b/i,
    term: 'AI-assisted development',
  },
  { pattern: /\bprompt engineer(ing|ed)\b/i, term: 'prompt engineering' },
  /* No trailing boundary: a version number follows the name — "Qwen2.5". */
  { pattern: /\b(qwen|ollama|llama|mistral|gpt-?\d|claude)/i, term: 'a model name' },
  { pattern: /\blanguage model\b|\bLLM\b/i, term: 'a language model' },
  {
    pattern: /\bproductivity multiplier\b|\bvelocity factor\b/i,
    term: 'an internal productivity multiplier',
  },
  { pattern: /\bconfidence (score|level|figure)\b/i, term: 'an internal confidence figure' },
  { pattern: /\bgenerated by (AI|a model)\b|\bAI[- ]generated\b/i, term: 'AI generation' },
];

export function internalMethodologyTerms(text: string): readonly string[] {
  return INTERNAL_METHODOLOGY_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ term }) => term,
  );
}

/* ------------------------------------------------------------- staffing */

/**
 * A commitment to put specific people on the job.
 *
 * "Two backend developers will be assigned" is a staffing promise. Unless the
 * approved capacity plan established it, nobody made that promise, and a client
 * reading it has been told something untrue about how their project is resourced.
 * Responsibilities are safe: "Backend engineering — API and server-side business
 * logic" claims nothing about headcount.
 */
export const STAFFING_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(dedicated\s+)?(developers?|engineers?|designers?|testers?|analysts?|architects?)\b/i,
  /\bteam of\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i,
  /\b(will be|are|shall be)\s+assigned\b/i,
  /\bfull[- ]time (developer|engineer|designer|resource)s?\b/i,
  /\bnamed (resource|developer|engineer)s?\b/i,
];

export function staffingClaims(text: string): readonly string[] {
  return STAFFING_CLAIM_PATTERNS.map((pattern) => pattern.exec(text)?.[0])
    .filter((match): match is string => match !== undefined)
    .map((match) => match.trim());
}

/* -------------------------------------------------------------- timeline */

/** How the approved estimate expressed its schedule. */
export const TIMELINE_BASES = ['RELATIVE', 'FIXED_DEADLINE', 'ABSOLUTE_START'] as const;

export type TimelineBasis = (typeof TIMELINE_BASES)[number];

export const sowTimelineSchema = z
  .object({
    basis: z.enum(TIMELINE_BASES),
    /** Working weeks from the approved schedule. */
    workingWeeks: z.number().nonnegative().optional(),
    workingDays: z.number().int().nonnegative().optional(),
    /** Present only when the project has one. Never constructed. */
    startDate: z.string().max(30).optional(),
    /** The client's deadline, preserved exactly. */
    deadline: z.string().max(30).optional(),
    /** The approved feasibility verdict, including an acknowledged risky one. */
    feasibility: z.string().max(40).optional(),
    /** True when the estimate was approved despite a high-risk verdict. */
    acknowledgedRisk: z.boolean(),
  })
  .strict();

export type SowTimeline = z.infer<typeof sowTimelineSchema>;

/**
 * The timeline sentence, in the only form the approved estimate permits.
 *
 * No calendar arithmetic anywhere in here. With no start date there is no date to
 * compute from, and computing one would be inventing the commencement the estimate
 * deliberately left open.
 */
export function timelineStatement(timeline: SowTimeline): string {
  const duration =
    timeline.workingWeeks !== undefined
      ? `approximately ${timeline.workingWeeks} working ${timeline.workingWeeks === 1 ? 'week' : 'weeks'}`
      : timeline.workingDays !== undefined
        ? `approximately ${timeline.workingDays} working days`
        : 'the duration set out in the approved estimate';

  if (timeline.basis === 'FIXED_DEADLINE' && timeline.deadline) {
    return `Implementation is planned for delivery by ${timeline.deadline}, over ${duration} of effort.`;
  }

  if (timeline.basis === 'ABSOLUTE_START' && timeline.startDate) {
    return `Implementation is planned over ${duration} from ${timeline.startDate}.`;
  }

  return `Implementation is planned over ${duration} following the agreed project commencement. Dates will be confirmed once a start date is agreed.`;
}

/** Whether a timeline section has invented a date the estimate never had. */
export function inventedDates(text: string, timeline: SowTimeline): readonly string[] {
  const permitted = [timeline.startDate, timeline.deadline]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());

  const patterns: readonly RegExp[] = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi,
    /\bQ[1-4]\s*\d{4}\b/gi,
  ];

  const found: string[] = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!permitted.some((value) => match[0].toLowerCase().includes(value))) {
        found.push(match[0]);
      }
    }
  }

  return [...new Set(found)];
}

/* ---------------------------------------------------------- deliverables */

/** A deliverable, which must trace to something approved. */
export const sowDeliverableSchema = z
  .object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(300),
    description: z.string().max(1_000),
    /** What in the approved scope this deliverable is. */
    requirementIds: z.array(z.string().max(64)).max(200),
    featureIds: z.array(z.string().max(64)).max(500),
  })
  .strict();

export type SowDeliverable = z.infer<typeof sowDeliverableSchema>;

/**
 * Deliverables nobody agreed to.
 *
 * The generic ones a document generator reaches for when a section looks thin.
 * Each is a promise of work that was never scoped or estimated.
 */
export const UNSUPPORTED_DELIVERABLE_PATTERNS: readonly RegExp[] = [
  /\bcomplete (enterprise )?documentation package\b/i,
  /\bfull (training|handover) programme?\b/i,
  /\bcomprehensive test suite\b/i,
  /\bongoing (support|maintenance)\b/i,
  /\bsource code (ownership|transfer)\b/i,
  /\bmarketing (site|materials?)\b/i,
];

export function unsupportedDeliverables(text: string): readonly string[] {
  return UNSUPPORTED_DELIVERABLE_PATTERNS.map((pattern) => pattern.exec(text)?.[0])
    .filter((match): match is string => match !== undefined)
    .map((match) => match.trim());
}

/* ------------------------------------------------- scope reconciliation */

/**
 * Whether the SOW's stated scope is the approved scope.
 *
 * Both directions. Scope in the document that is not in the Feature Listing is
 * work nobody estimated; scope in the Feature Listing that the document omits is
 * work the client has not been told they are buying. Neither is acceptable in a
 * commercial document, and the second is the one that gets missed.
 */
export const sowScopeReconciliationSchema = z
  .object({
    approvedFeatures: z.number().int().nonnegative(),
    statedFeatures: z.number().int().nonnegative(),
    /** In the Feature Listing, absent from the SOW. */
    missingFeatureIds: z.array(z.string().max(64)).max(500),
    /** In the SOW, absent from the Feature Listing. */
    unknownFeatureIds: z.array(z.string().max(64)).max(500),
    /** Out-of-scope items the SOW nonetheless describes as included. */
    contradictedExclusions: z.array(z.string().max(300)).max(100),
    reconciled: z.boolean(),
  })
  .strict();

export type SowScopeReconciliation = z.infer<typeof sowScopeReconciliationSchema>;

export function reconcileSowScope(input: {
  readonly approvedFeatureIds: readonly string[];
  readonly statedFeatureIds: readonly string[];
  readonly exclusions: readonly string[];
  readonly includedText: string;
}): SowScopeReconciliation {
  const approved = new Set(input.approvedFeatureIds);
  const stated = new Set(input.statedFeatureIds);

  const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const included = normalise(input.includedText);

  const contradictedExclusions = input.exclusions.filter((exclusion) => {
    const phrase = normalise(exclusion);

    return phrase.length > 12 && included.includes(phrase);
  });

  const missingFeatureIds = input.approvedFeatureIds.filter((id) => !stated.has(id));
  const unknownFeatureIds = input.statedFeatureIds.filter((id) => !approved.has(id));

  return {
    approvedFeatures: approved.size,
    statedFeatures: stated.size,
    missingFeatureIds,
    unknownFeatureIds,
    contradictedExclusions,
    reconciled:
      missingFeatureIds.length === 0 &&
      unknownFeatureIds.length === 0 &&
      contradictedExclusions.length === 0,
  };
}

/* --------------------------------------------------------- write shapes */

/** What a model may return for one SOW section: prose, and nothing else. */
export const sowSectionDraftSchema = z
  .object({
    key: z.string().min(1).max(64),
    body: z.string().min(1).max(20_000),
    /** Requirement keys the prose rests on. Verified before storage. */
    requirementKeys: z.array(z.string().max(64)).max(200),
  })
  .strict();

export type SowSectionDraft = z.infer<typeof sowSectionDraftSchema>;
