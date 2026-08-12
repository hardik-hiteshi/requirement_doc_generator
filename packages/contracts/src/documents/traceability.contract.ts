import { z } from 'zod';

import { DOCUMENT_TYPES } from './document-type.contract';

/**
 * One approved requirement, followed through every document that mentions it.
 *
 * ## The question this answers
 *
 * "We agreed to this. Where is it?" By the time seven documents exist, that is a
 * question nobody can answer by reading them — the requirement is cited by key in one
 * place, by feature id in another, and by estimate unit in a third. This view walks
 * those links so a reviewer can see the whole chain, and so a gap in it is visible
 * rather than discovered during delivery.
 *
 * ## Nothing here invents a link
 *
 * Every edge is one a document already recorded: a section's `references`, a feature
 * row's `requirementIds`, a criterion's, a work package's, a dependency's. Where a
 * document does not cite a requirement, the honest answer is that it does not appear —
 * and appearing is not always required, which is the next point.
 *
 * ## Three documents are conditional, and coverage says so
 *
 * Assumptions and the Client Dependency Sheet are answerable for recording what
 * somebody stood behind and what the client owes. A requirement with no assumption is
 * the *normal* case, not a gap, and counting it as one would make coverage a number
 * nobody could ever get to 100% — which is the same as having no number at all.
 * `isConditionalDocument` marks them, and they are reported without penalty.
 */

/** Documents a requirement is not obliged to appear in. */
export const CONDITIONAL_TRACE_DOCUMENTS = ['ASSUMPTIONS', 'CLIENT_DEPENDENCY_SHEET'] as const;

export type ConditionalTraceDocument = (typeof CONDITIONAL_TRACE_DOCUMENTS)[number];

export function isConditionalDocument(type: string): boolean {
  return (CONDITIONAL_TRACE_DOCUMENTS as readonly string[]).includes(type);
}

/* -------------------------------------------------------------- one link */

/** Where a requirement turns up in one document. */
export const traceLinkSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    /** The version this link was read from. */
    documentVersion: z.number().int().nonnegative(),
    /**
     * What to show the reader: `understanding`, `AC-004`, `1.2.3`, `CD-001`.
     *
     * A human-facing identifier, never a database id — this view is read by the same
     * people who read the documents.
     */
    key: z.string().max(64),
    label: z.string().max(300),
    /** True when the document that holds this link is no longer current. */
    stale: z.boolean(),
  })
  .strict();

export type TraceLink = z.infer<typeof traceLinkSchema>;

/* ------------------------------------------------------- one requirement */

export const requirementTraceSchema = z
  .object({
    requirementKey: z.string().max(64),
    title: z.string().max(300),
    category: z.string().max(40),
    priority: z.string().max(20),
    /** Every document link, in document order. */
    links: z.array(traceLinkSchema).max(200),
    /**
     * Documents that should mention this requirement and do not.
     *
     * Conditional documents are never listed here — see `isConditionalDocument`.
     */
    missingFrom: z.array(z.enum(DOCUMENT_TYPES)).max(7),
    /** Whether a person recorded this as deliberately out of scope somewhere. */
    excludedIn: z.array(z.enum(DOCUMENT_TYPES)).max(7),
    complete: z.boolean(),
  })
  .strict();

export type RequirementTrace = z.infer<typeof requirementTraceSchema>;

/* ------------------------------------------------- reverse: one artifact */

/**
 * A document row or section, followed back to the requirements behind it.
 *
 * The direction somebody uses when they are looking at a work package and asking why
 * it exists. A row citing nothing is the interesting case: it is either a legitimate
 * piece of overhead or something nobody agreed to, and only the document itself can
 * say which.
 */
export const artifactTraceSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    key: z.string().max(64),
    label: z.string().max(300),
    requirementKeys: z.array(z.string().max(64)).max(60),
    /** Cited keys that are not in the approved baseline. */
    danglingKeys: z.array(z.string().max(64)).max(60),
    /** True when the row is deliberately not about a requirement. */
    supportsDeliveryOnly: z.boolean(),
  })
  .strict();

export type ArtifactTrace = z.infer<typeof artifactTraceSchema>;

/* ---------------------------------------------------------- the coverage */

export const traceCoverageEntrySchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    /** Requirements this document is answerable for. */
    applicable: z.number().int().nonnegative(),
    represented: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    /** True when a requirement may legitimately be absent. */
    conditional: z.boolean(),
    /** Null for a document that has not been generated. */
    documentVersion: z.number().int().nonnegative().nullable(),
    stale: z.boolean(),
  })
  .strict();

export type TraceCoverageEntry = z.infer<typeof traceCoverageEntrySchema>;

/* ------------------------------------------------------------ the gaps */

export const TRACE_GAP_KINDS = [
  /** An approved requirement no Feature Listing row covers. */
  'requirement_unmapped',
  /** A functional feature with no acceptance criterion. */
  'feature_without_criterion',
  /** Approved scope absent from the work breakdown. */
  'scope_without_work',
  /** A row citing nothing at all. */
  'unsupported_row',
  /** A citation naming a requirement the baseline does not contain. */
  'dangling_reference',
  /** A dependency naming a work package that is not in the breakdown. */
  'dependency_without_work',
  /** A document whose links were read from a version that is no longer current. */
  'stale_trace',
] as const;

export type TraceGapKind = (typeof TRACE_GAP_KINDS)[number];

export const TRACE_GAP_SEVERITIES = ['BLOCKING', 'WARNING', 'INFO'] as const;
export type TraceGapSeverity = (typeof TRACE_GAP_SEVERITIES)[number];

/**
 * How much each kind of gap matters.
 *
 * Deliberately not all BLOCKING. A dangling citation is a document claiming support it
 * does not have, and that has to stop an approval; a work package with no requirement
 * may be perfectly legitimate overhead. Making every optional relationship a blocker
 * would teach people to acknowledge findings without reading them, which costs more
 * than the findings are worth.
 */
export const TRACE_GAP_SEVERITY: Readonly<Record<TraceGapKind, TraceGapSeverity>> = {
  requirement_unmapped: 'BLOCKING',
  feature_without_criterion: 'WARNING',
  scope_without_work: 'WARNING',
  unsupported_row: 'WARNING',
  dangling_reference: 'BLOCKING',
  dependency_without_work: 'BLOCKING',
  stale_trace: 'INFO',
};

export const traceGapSchema = z
  .object({
    kind: z.enum(TRACE_GAP_KINDS),
    severity: z.enum(TRACE_GAP_SEVERITIES),
    documentType: z.enum(DOCUMENT_TYPES).nullable(),
    summary: z.string().max(300),
    subjectKeys: z.array(z.string().max(64)).max(200),
  })
  .strict();

export type TraceGap = z.infer<typeof traceGapSchema>;

/* ----------------------------------------------------------- the whole view */

export const traceabilityViewSchema = z
  .object({
    projectId: z.string().max(64),
    /** Null when no baseline is approved: there is nothing to trace from. */
    baselineVersion: z.number().int().nonnegative().nullable(),
    requirements: z.array(requirementTraceSchema).max(2_000),
    coverage: z.array(traceCoverageEntrySchema).max(7),
    gaps: z.array(traceGapSchema).max(200),
    /** Requirements fully represented in every document that owes them. */
    completeCount: z.number().int().nonnegative(),
    generatedAt: z.string().datetime(),
  })
  .strict();

export type TraceabilityView = z.infer<typeof traceabilityViewSchema>;

/**
 * Whether a requirement is represented everywhere it has to be.
 *
 * `missingFrom` already excludes conditional documents and documents that do not
 * exist yet, so this is a straight emptiness check rather than a second set of rules
 * that could disagree with the first.
 */
export function isTraceComplete(
  trace: Pick<RequirementTrace, 'missingFrom' | 'excludedIn'>,
): boolean {
  return trace.missingFrom.length === 0;
}

/** Requirements with nothing against them in a given document. */
export function requirementsMissingFrom(
  requirements: readonly RequirementTrace[],
  documentType: string,
): readonly string[] {
  return requirements
    .filter((trace) => (trace.missingFrom as readonly string[]).includes(documentType))
    .map((trace) => trace.requirementKey);
}
