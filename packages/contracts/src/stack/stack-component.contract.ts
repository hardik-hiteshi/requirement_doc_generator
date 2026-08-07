import { z } from 'zod';

import {
  selectionSourceSchema,
  stackAuthorityLevelSchema,
  stackComponentStatusSchema,
} from './stack-authority.contract';
import { technologyCategorySchema } from './technology-category.contract';
import { costPostureSchema } from './technology-catalog.contract';

/**
 * One technology in one category, and everything known about how it got there.
 *
 * The record a later phase reads. Estimation prices the work it implies, the
 * Statement of Work names it, the Client Dependency Sheet asks who provides it —
 * so a field that is guessed here becomes a guess in a signed document.
 *
 * Hence the split that runs through the whole file: **facts about the
 * technology** come from the catalogue, **facts about the decision** come from
 * the user or the recommendation run, and the model contributes only prose it
 * is asked for and a self-assessment that decides nothing.
 */

/* ------------------------------------------------------------- versions */

/**
 * Where a version number came from, or that there is not one.
 *
 * A model asked for "the latest version" will answer, fluently, with a number
 * it has no way to know — and a wrong version in a proposal is a commitment
 * nobody can meet. So a version is only ever recorded with a provenance, and
 * `UNSPECIFIED` is both the default and the honest answer almost always.
 */
export const VERSION_SOURCES = [
  /** A requirement mandates it. Non-negotiable. */
  'REQUIRED_VERSION',
  /** The user typed it. */
  'USER_SELECTED_VERSION',
  /** A reviewed catalogue entry carries it. */
  'CATALOG_RECOMMENDED_VERSION',
  /** No version is pinned, and none is claimed. */
  'UNSPECIFIED',
] as const;

export type VersionSource = (typeof VERSION_SOURCES)[number];
export const versionSourceSchema = z.enum(VERSION_SOURCES);

export const VERSION_SOURCE_LABELS: Readonly<Record<VersionSource, string>> = {
  REQUIRED_VERSION: 'Required by the requirements',
  USER_SELECTED_VERSION: 'Your choice',
  CATALOG_RECOMMENDED_VERSION: 'Reviewed recommendation',
  UNSPECIFIED: 'Not pinned',
};

export const componentVersionSchema = z
  .object({
    source: versionSourceSchema,
    /** Absent whenever the source is `UNSPECIFIED`, enforced below. */
    value: z.string().max(30).optional(),
  })
  .strict()
  .refine(
    (version) => (version.source === 'UNSPECIFIED') === (version.value === undefined),
    'A pinned version needs a value, and an unpinned one must not have any',
  );

export type ComponentVersion = z.infer<typeof componentVersionSchema>;

export const UNPINNED_VERSION: ComponentVersion = { source: 'UNSPECIFIED' };

/* ----------------------------------------------------------- evidence */

/**
 * Why a technology is in the stack, and on whose authority.
 *
 * The distinction the specification insists on: a requirement the client wrote
 * and a conclusion the architecture implies are both legitimate reasons, and
 * presenting the second as the first is a lie about where a decision came from.
 * A client reading *"you require PostgreSQL"* when they required no such thing
 * has been misrepresented in their own proposal.
 */
export const STACK_EVIDENCE_KINDS = [
  /** Something in the approved baseline says so. */
  'CLIENT_REQUIREMENT',
  /** A confirmed clarification answer says so. */
  'CONFIRMED_CLARIFICATION',
  /** Follows from choices already made, not from anything the client said. */
  'ARCHITECTURAL_DERIVATION',
  /** A constraint the user entered: budget, hosting, compliance. */
  'PROJECT_CONSTRAINT',
  /** The user simply chose it. Authoritative, and not dressed as anything else. */
  'USER_PREFERENCE',
] as const;

export type StackEvidenceKind = (typeof STACK_EVIDENCE_KINDS)[number];
export const stackEvidenceKindSchema = z.enum(STACK_EVIDENCE_KINDS);

export const STACK_EVIDENCE_KIND_LABELS: Readonly<Record<StackEvidenceKind, string>> = {
  CLIENT_REQUIREMENT: 'From your requirements',
  CONFIRMED_CLARIFICATION: 'From a confirmed answer',
  ARCHITECTURAL_DERIVATION: 'Follows from the architecture',
  PROJECT_CONSTRAINT: 'From a constraint you set',
  USER_PREFERENCE: 'Your preference',
};

export const STACK_EVIDENCE_KIND_DESCRIPTIONS: Readonly<Record<StackEvidenceKind, string>> = {
  CLIENT_REQUIREMENT: 'An approved requirement asks for this.',
  CONFIRMED_CLARIFICATION: 'A clarification you confirmed asks for this.',
  ARCHITECTURAL_DERIVATION:
    'Nobody asked for this directly — it follows from other decisions. It is not presented as a client requirement.',
  PROJECT_CONSTRAINT: 'A constraint you entered — hosting, budget or compliance — leads here.',
  USER_PREFERENCE: 'You chose it. No requirement asked for it either way.',
};

/** Evidence kinds that represent something the client actually said. */
export const CLIENT_STACK_EVIDENCE_KINDS: readonly StackEvidenceKind[] = [
  'CLIENT_REQUIREMENT',
  'CONFIRMED_CLARIFICATION',
];

export function isClientEvidence(kind: StackEvidenceKind): boolean {
  return CLIENT_STACK_EVIDENCE_KINDS.includes(kind);
}

export const stackEvidenceSchema = z
  .object({
    kind: stackEvidenceKindSchema,
    /** Requirement ids from the approved baseline. Verified to exist. */
    requirementIds: z.array(z.string().max(64)).max(30),
    /** Source documents behind those requirements, for a one-click check. */
    sourceIds: z.array(z.string().max(64)).max(20),
    /** Clarification keys, where the evidence is a confirmed answer. */
    clarificationKeys: z.array(z.string().max(32)).max(10),
    /** One sentence, specific to this project. Never "it is the best". */
    summary: z.string().min(1).max(400),
  })
  .strict();

export type StackEvidence = z.infer<typeof stackEvidenceSchema>;

/* ---------------------------------------------------------- component */

/**
 * What the model said about a technology, kept apart from what is known.
 *
 * Every field here is prose or a self-assessment. None of it gates anything:
 * approval, compatibility and evidence strength are all computed elsewhere from
 * stored facts. It is here to be read by a person deciding, and labelled so they
 * know what they are reading.
 */
export const recommendationDetailSchema = z
  .object({
    /** Why this one, for this project. Requirement-specific or it is not useful. */
    rationale: z.string().min(1).max(1200),
    benefits: z.array(z.string().min(1).max(300)).max(6),
    limitations: z.array(z.string().min(1).max(300)).max(6),
    risks: z.array(z.string().min(1).max(300)).max(6),
    operationalConsiderations: z.array(z.string().min(1).max(300)).max(6),
    /** A second option, and why someone might prefer it. */
    alternativeTechnologyId: z.string().max(64).optional(),
    alternativeReason: z.string().max(600).optional(),
    /**
     * The model's own estimate of how sure it is.
     *
     * Carried through Phase 4's rule unchanged: it is a self-assessment, it is
     * not a probability, it decides nothing, and it is always shown labelled.
     */
    modelConfidence: z.number().min(0).max(1),
    /** Which prompt produced it, so the output stays attributable. */
    promptVersion: z.string().min(1).max(20),
    runId: z.string().min(1).max(64),
  })
  .strict();

export type RecommendationDetail = z.infer<typeof recommendationDetailSchema>;

/**
 * A user's acknowledgement that they are keeping something risky.
 *
 * Recorded once, against the risk as it stood. If the underlying requirement
 * later changes, the risk is recomputed and the acknowledgement no longer covers
 * it — which is the difference between asking once and nagging.
 */
export const riskAcknowledgementSchema = z
  .object({
    findingId: z.string().min(1).max(64),
    /** What was acknowledged, in the words shown at the time. */
    summary: z.string().min(1).max(400),
    note: z.string().max(1000),
    acknowledgedAt: z.iso.datetime(),
    /** The evidence the risk was computed from, so a change invalidates it. */
    requirementIds: z.array(z.string().max(64)).max(30),
  })
  .strict();

export type RiskAcknowledgement = z.infer<typeof riskAcknowledgementSchema>;

export const stackComponentSchema = z
  .object({
    id: z.string().min(1).max(64),
    category: technologyCategorySchema,
    /**
     * The catalogue id, absent for a technology the user typed.
     *
     * Its absence is the only thing that makes a component custom, and it is
     * what tells the UI to show "no reviewed facts held" rather than blanks that
     * read like facts.
     */
    technologyId: z.string().max(64).optional(),
    /** Always present. The catalogue name, or exactly what the user typed. */
    technologyName: z.string().min(1).max(120),
    status: stackComponentStatusSchema,
    authority: stackAuthorityLevelSchema,
    /** Where a user selection came from. Absent on a pure recommendation. */
    selectionSource: selectionSourceSchema.optional(),
    /** Set when a requirement mandates this technology by name. */
    mandatory: z.boolean(),
    version: componentVersionSchema,
    evidence: stackEvidenceSchema,
    /**
     * Application-computed, 0–1. Never assigned by the model.
     *
     * See `stack-evidence.ts` — the score is a sum of named signals over stored
     * facts, and the contributions are shown.
     */
    evidenceStrength: z.number().min(0).max(1),
    /** Facts copied from the catalogue at the time of the decision. */
    licence: z.string().max(60),
    costPosture: costPostureSchema,
    selfHostable: z.boolean(),
    recommendation: recommendationDetailSchema.optional(),
    riskAcknowledgements: z.array(riskAcknowledgementSchema).max(20),
    /** Free text the user wrote against this choice. */
    notes: z.string().max(2000),
    /** What this replaced, so the record shows what was considered. */
    replacedTechnologyName: z.string().max(120).optional(),
    replacedReason: z.string().max(600).optional(),
    lockedAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type StackComponent = z.infer<typeof stackComponentSchema>;

/** A component with no reviewed catalogue facts behind it. */
export function isCustomTechnology(component: Pick<StackComponent, 'technologyId'>): boolean {
  return component.technologyId === undefined;
}

/* -------------------------------------------------------- write shapes */

export const selectTechnologySchema = z
  .object({
    category: technologyCategorySchema,
    /** One of these two. A catalogue id wins if both arrive. */
    technologyId: z.string().max(64).optional(),
    customName: z.string().max(120).optional(),
    selectionSource: selectionSourceSchema,
    /** Set when a requirement mandates it rather than the user preferring it. */
    mandatory: z.boolean(),
    version: componentVersionSchema.optional(),
    notes: z.string().max(2000).optional(),
    /** Requirement ids the user is citing, verified against the baseline. */
    requirementIds: z.array(z.string().max(64)).max(30).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.technologyId) || Boolean(input.customName?.trim()),
    'Name a technology, either from the catalogue or your own',
  );

export type SelectTechnology = z.infer<typeof selectTechnologySchema>;

export const RECOMMENDATION_DECISIONS = ['accept', 'reject', 'replace'] as const;
export type RecommendationDecision = (typeof RECOMMENDATION_DECISIONS)[number];

export const decideRecommendationSchema = z
  .object({
    decision: z.enum(RECOMMENDATION_DECISIONS),
    /** Required for `replace`: what to put there instead. */
    technologyId: z.string().max(64).optional(),
    customName: z.string().max(120).optional(),
    reason: z.string().max(600).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (input) =>
      input.decision !== 'replace' ||
      Boolean(input.technologyId) ||
      Boolean(input.customName?.trim()),
    'Say what should replace it',
  );

export type DecideRecommendation = z.infer<typeof decideRecommendationSchema>;

export const acknowledgeRiskSchema = z
  .object({
    findingId: z.string().min(1).max(64),
    note: z.string().max(1000).optional(),
    /**
     * An explicit "I have read this and I am keeping it anyway".
     *
     * Not a default, for the same reason baseline approval is not: the whole
     * value of the acknowledgement is that somebody had to do something.
     */
    acknowledged: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AcknowledgeRisk = z.infer<typeof acknowledgeRiskSchema>;
