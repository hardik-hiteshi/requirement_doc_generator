import { z } from 'zod';

import { DOCUMENT_TYPES, type DocumentType } from './document-type.contract';
import { isDocumentAuthoritative, type DocumentStatus } from './document-status.contract';

/**
 * What each document is allowed to be built from, and what invalidates it.
 *
 * The whole reason this is a table rather than logic in seven services: adding
 * Acceptance Criteria in a later phase should be one row here, not a new
 * propagation rule copied and adjusted. The engine reads this; it knows nothing
 * about any particular document.
 *
 * ## The current graph
 *
 * ```
 *   approved requirement baseline
 *              ↓
 *      Our Understanding
 *              ↓
 *       Feature Listing  ←  locked technology stack
 *                        ←  approved estimation snapshot
 * ```
 *
 * Feature Listing depends on Our Understanding *and* directly on the stack and
 * the estimate. Both edges are real: the narrative constrains what the features
 * are, and the estimate is where the hours come from. A row here records both.
 */

/** The upstream artifacts a document can depend on, besides other documents. */
export const UPSTREAM_KINDS = [
  'REQUIREMENT_BASELINE',
  'TECHNOLOGY_STACK',
  'ESTIMATION_SNAPSHOT',
] as const;

export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];

export const UPSTREAM_LABELS: Readonly<Record<UpstreamKind, string>> = {
  REQUIREMENT_BASELINE: 'the approved requirements',
  TECHNOLOGY_STACK: 'the locked technology stack',
  ESTIMATION_SNAPSHOT: 'the approved estimate',
};

export interface DocumentDependencies {
  /** Upstream artifacts that must be current, and that invalidate on change. */
  readonly upstream: readonly UpstreamKind[];
  /** Documents that must be approved before this one may be generated. */
  readonly documents: readonly DocumentType[];
}

export const DOCUMENT_DEPENDENCIES: Readonly<Record<DocumentType, DocumentDependencies>> = {
  OUR_UNDERSTANDING: {
    upstream: ['REQUIREMENT_BASELINE'],
    documents: [],
  },
  FEATURE_LISTING: {
    upstream: ['REQUIREMENT_BASELINE', 'TECHNOLOGY_STACK', 'ESTIMATION_SNAPSHOT'],
    documents: ['OUR_UNDERSTANDING'],
  },
  /*
   * Declared, not implemented. The edges are recorded now because the graph is
   * the thing later phases plug into — and because writing them down is how the
   * engine gets designed for seven documents rather than retro-fitted from two.
   */
  ACCEPTANCE_CRITERIA: {
    upstream: ['REQUIREMENT_BASELINE'],
    documents: ['FEATURE_LISTING'],
  },
  ASSUMPTIONS: {
    upstream: ['REQUIREMENT_BASELINE'],
    documents: ['OUR_UNDERSTANDING'],
  },
  STATEMENT_OF_WORK: {
    upstream: ['REQUIREMENT_BASELINE', 'TECHNOLOGY_STACK', 'ESTIMATION_SNAPSHOT'],
    documents: ['OUR_UNDERSTANDING', 'FEATURE_LISTING'],
  },
  WORK_BREAKDOWN_STRUCTURE: {
    upstream: ['ESTIMATION_SNAPSHOT'],
    documents: ['FEATURE_LISTING'],
  },
  CLIENT_DEPENDENCY_SHEET: {
    upstream: ['REQUIREMENT_BASELINE'],
    documents: ['OUR_UNDERSTANDING'],
  },
};

/** Documents that name `type` as a prerequisite. Used to propagate outdatedness. */
export function documentsDependingOn(type: DocumentType): readonly DocumentType[] {
  return DOCUMENT_TYPES.filter((candidate) =>
    DOCUMENT_DEPENDENCIES[candidate].documents.includes(type),
  );
}

/** Documents invalidated when an upstream artifact of this kind changes. */
export function documentsDependingOnUpstream(kind: UpstreamKind): readonly DocumentType[] {
  return DOCUMENT_TYPES.filter((candidate) =>
    DOCUMENT_DEPENDENCIES[candidate].upstream.includes(kind),
  );
}

/* --------------------------------------------------------------- locking */

/** Why a document cannot be generated yet. */
export const DOCUMENT_LOCK_REASONS = [
  'not_implemented',
  'upstream_missing',
  'prerequisite_document',
] as const;

export type DocumentLockReason = (typeof DOCUMENT_LOCK_REASONS)[number];

export interface DocumentLock {
  readonly reason: DocumentLockReason;
  /** One sentence a user can act on. */
  readonly summary: string;
}

export interface DependencyState {
  /** Upstream artifacts that exist and are current. */
  readonly availableUpstream: readonly UpstreamKind[];
  /** Status of every document in the project, by type. */
  readonly documentStatuses: Readonly<Partial<Record<DocumentType, DocumentStatus>>>;
}

/**
 * Whether a document may be generated, and if not, the reason.
 *
 * Ordering matters. An unimplemented document reports that first — telling
 * somebody to approve a baseline so they can generate a document that does not
 * exist would be worse than saying nothing. Then upstream, then documents,
 * because a missing baseline is the more fundamental problem and fixing the
 * order of the message changes what the user does next.
 */
export function lockFor(
  type: DocumentType,
  state: DependencyState,
  implemented: readonly DocumentType[],
): DocumentLock | null {
  if (!implemented.includes(type)) {
    return {
      reason: 'not_implemented',
      summary: 'This document is not available yet.',
    };
  }

  const dependencies = DOCUMENT_DEPENDENCIES[type];

  const missing = dependencies.upstream.filter((kind) => !state.availableUpstream.includes(kind));

  if (missing.length > 0) {
    return {
      reason: 'upstream_missing',
      summary: `This document needs ${missing.map((kind) => UPSTREAM_LABELS[kind]).join(' and ')}.`,
    };
  }

  const unapproved = dependencies.documents.filter(
    (prerequisite) =>
      !isDocumentAuthoritative(state.documentStatuses[prerequisite] ?? 'NOT_STARTED'),
  );

  if (unapproved.length > 0) {
    return {
      reason: 'prerequisite_document',
      summary: `Approve ${unapproved.join(' and ')} first — this document is built on it.`,
    };
  }

  return null;
}

/* ---------------------------------------------------- outdated propagation */

/** Why a document went out of date. Each is a fact about an input. */
export const OUTDATED_CAUSES = [
  'baseline_changed',
  'stack_changed',
  'estimate_changed',
  'prerequisite_document_changed',
] as const;

export type OutdatedCause = (typeof OUTDATED_CAUSES)[number];

export const documentOutdatedReasonSchema = z
  .object({
    cause: z.enum(OUTDATED_CAUSES),
    /** What changed, in the user's terms. Never the document's content. */
    summary: z.string().min(1).max(300),
    /** The prerequisite document, when that is what moved. */
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    /** Version this document was generated against. */
    generatedAgainst: z.string().max(64).optional(),
    /** Version that is current now. */
    currentVersion: z.string().max(64).optional(),
  })
  .strict();

export type DocumentOutdatedReason = z.infer<typeof documentOutdatedReasonSchema>;

export interface UpstreamVersions {
  readonly baselineVersion?: number;
  readonly stackVersion?: number;
  readonly estimateVersion?: number;
}

export interface OutdatedInput {
  readonly type: DocumentType;
  /** Versions the document was generated against. */
  readonly generatedAgainst: UpstreamVersions;
  /** Versions that are current now. */
  readonly current: UpstreamVersions;
  /** Prerequisite documents whose approval was withdrawn or re-approved since. */
  readonly changedPrerequisites: readonly DocumentType[];
}

/**
 * Every reason this document is out of date, or an empty list.
 *
 * **Nothing is recalculated here.** An outdated document keeps saying exactly
 * what it said; this returns the reasons a person should know about, and the
 * decision to regenerate is theirs. Silently regenerating a document somebody
 * has read, edited and possibly sent is the failure this design exists to
 * prevent.
 *
 * A version comparison only reports when both sides are known. A document
 * generated before an input existed is not out of date with respect to it — it
 * simply never used it.
 */
export function documentOutdatedReasons(input: OutdatedInput): readonly DocumentOutdatedReason[] {
  const dependencies = DOCUMENT_DEPENDENCIES[input.type];
  const reasons: DocumentOutdatedReason[] = [];

  const compare = (
    kind: UpstreamKind,
    cause: OutdatedCause,
    was: number | undefined,
    now: number | undefined,
    noun: string,
  ): void => {
    if (!dependencies.upstream.includes(kind) || was === undefined) {
      return;
    }

    /*
     * The input has gone entirely — a stack unlocked, an estimate reopened. That
     * is a stronger statement than a version change: the document is quoting
     * something that is no longer authority at all.
     */
    if (now === undefined) {
      reasons.push({
        cause,
        summary: `${noun} is no longer approved, and this document was written against v${was}.`,
        generatedAgainst: `v${was}`,
      });

      return;
    }

    if (was !== now) {
      reasons.push({
        cause,
        summary: `${noun} changed after this document was written — it was written against v${was} and v${now} is current.`,
        generatedAgainst: `v${was}`,
        currentVersion: `v${now}`,
      });
    }
  };

  compare(
    'REQUIREMENT_BASELINE',
    'baseline_changed',
    input.generatedAgainst.baselineVersion,
    input.current.baselineVersion,
    'The approved requirements',
  );
  compare(
    'TECHNOLOGY_STACK',
    'stack_changed',
    input.generatedAgainst.stackVersion,
    input.current.stackVersion,
    'The locked technology stack',
  );
  compare(
    'ESTIMATION_SNAPSHOT',
    'estimate_changed',
    input.generatedAgainst.estimateVersion,
    input.current.estimateVersion,
    'The approved estimate',
  );

  for (const prerequisite of input.changedPrerequisites) {
    if (dependencies.documents.includes(prerequisite)) {
      reasons.push({
        cause: 'prerequisite_document_changed',
        documentType: prerequisite,
        summary: `${prerequisite} changed after this document was written.`,
      });
    }
  }

  return reasons;
}
