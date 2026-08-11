import { z } from 'zod';

/**
 * A controlled document has **two** independent properties, and conflating them
 * is how a document system ends up unable to answer a simple question.
 *
 * ## Lifecycle status — what people have decided about this content
 *
 * Eight states, and two of them are routinely confused.
 *
 * **`APPROVED` is not `FINAL`.** Approved means the content is agreed and
 * downstream documents may build on it. Final means it has been issued — it left
 * the building. An approved document can be reopened and revised; a final one is
 * a matter of record, and the only way past it is a new version. Collapsing the
 * two makes "which version did the client actually receive?" unanswerable.
 *
 * **`NEEDS_REVISION` is a decision.** A person read the document and wants it
 * changed. Every status here is like that: something a person did.
 *
 * ## Currentness — whether the world has moved since
 *
 * `CURRENT` or `OUTDATED`. Nobody chooses this; it is derived, every time the
 * document is read, by comparing the upstream versions the content was written
 * against with the versions that are authoritative now.
 *
 * ## Why they are separate axes
 *
 * Because a document can be both issued and stale, and both facts matter:
 *
 * ```
 *   status = FINAL          the immutable version that was sent to the client
 *   currentness = OUTDATED  the project has changed since it was sent
 * ```
 *
 * When `OUTDATED` was a *status*, that combination could not be expressed. The
 * engine had to choose: relabel the issued document — making the history lie
 * about what was sent — or leave it saying `FINAL` and silently drop the fact
 * that it no longer matches the project. Neither is acceptable in a document
 * somebody may have to produce in a dispute.
 *
 * Separating them also removes a special case. An approved document whose inputs
 * moved is `APPROVED` + `OUTDATED`: still approved, because nobody withdrew that
 * decision, and still editable and regenerable, because that is the action the
 * screen advises. What it may not do is be *newly* approved or issued while
 * stale, which is a rule about currentness, checked as one.
 */
export const DOCUMENT_STATUSES = [
  /** Nothing has been generated. The default for every document. */
  'NOT_STARTED',
  /** A generation run has been accepted and has not started. */
  'QUEUED',
  /** A generation run is working. */
  'GENERATING',
  /** Generated content exists and nobody has approved it. */
  'DRAFT',
  /** A reviewer asked for changes. */
  'NEEDS_REVISION',
  /** The content is agreed. Downstream documents may build on it. */
  'APPROVED',
  /** Issued. A matter of record, revised only through a new version. */
  'FINAL',
  /** A generation run failed. Previous content, if any, is untouched. */
  'FAILED',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);

export const DOCUMENT_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  NOT_STARTED: 'Not started',
  QUEUED: 'Queued',
  GENERATING: 'Writing',
  DRAFT: 'Draft',
  NEEDS_REVISION: 'Needs changes',
  APPROVED: 'Approved',
  FINAL: 'Issued',
  FAILED: 'Failed',
};

/* ------------------------------------------------------------ currentness */

/**
 * Whether the document still reflects the project it was written from.
 *
 * Derived, never stored as the source of truth and never set by a user. The
 * reasons behind `OUTDATED` are on the document as `outdatedReasons`, each one a
 * fact about an input rather than a judgement about the content.
 */
export const DOCUMENT_CURRENTNESS = ['CURRENT', 'OUTDATED'] as const;

export type DocumentCurrentness = (typeof DOCUMENT_CURRENTNESS)[number];
export const documentCurrentnessSchema = z.enum(DOCUMENT_CURRENTNESS);

export interface DocumentState {
  readonly status: DocumentStatus;
  readonly currentness: DocumentCurrentness;
}

/**
 * What to call a document on screen, given both axes.
 *
 * "Issued" and "Issued — out of date" are different things to a reader, and the
 * second one is the one that needs saying out loud.
 */
export function documentStateLabel(state: DocumentState): string {
  const status = DOCUMENT_STATUS_LABELS[state.status];

  return state.currentness === 'OUTDATED' ? `${status} — out of date` : status;
}

/** The sentence under the label, when a document is no longer current. */
export const OUTDATED_EXPLANATIONS: Readonly<Partial<Record<DocumentStatus, string>>> = {
  FINAL:
    'Issued previously. Project requirements or upstream decisions have changed since this version was issued.',
  APPROVED:
    'Approved previously. Project requirements or upstream decisions have changed since it was approved.',
  DRAFT: 'Project requirements or upstream decisions have changed since this draft was written.',
  NEEDS_REVISION:
    'Project requirements or upstream decisions have changed since this draft was written.',
};

export function outdatedExplanation(state: DocumentState): string | null {
  return state.currentness === 'OUTDATED' ? (OUTDATED_EXPLANATIONS[state.status] ?? null) : null;
}

/* ------------------------------------------------------------ transitions */

/**
 * Every legal move, and nothing else.
 *
 * Written as a table rather than as conditionals in a service, so the rules can
 * be read in one place and tested without a database.
 *
 * `FINAL` has no exits. That is the point of it: reissuing means a new version,
 * which is a new working record beside the issued one, not a state change on it.
 *
 * Currentness appears nowhere in this table, because nothing here is a move
 * between currentness values — there is no transition to make. What currentness
 * governs is whether a move is *allowed*, which is `canApproveDocument` and
 * `canIssueDocument` below.
 */
export const DOCUMENT_TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  NOT_STARTED: ['QUEUED'],
  QUEUED: ['GENERATING', 'FAILED'],
  GENERATING: ['DRAFT', 'FAILED'],
  DRAFT: ['QUEUED', 'DRAFT', 'NEEDS_REVISION', 'APPROVED'],
  NEEDS_REVISION: ['QUEUED', 'DRAFT', 'NEEDS_REVISION', 'APPROVED'],
  APPROVED: ['QUEUED', 'DRAFT', 'NEEDS_REVISION', 'FINAL'],
  FINAL: [],
  FAILED: ['QUEUED', 'NOT_STARTED'],
};

export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return DOCUMENT_TRANSITIONS[from].includes(to);
}

/**
 * Statuses where a downstream document may treat this one as authority.
 *
 * Status alone is not enough — see `isAuthoritativeState`, which is what the
 * dependency graph actually asks.
 */
export const AUTHORITATIVE_DOCUMENT_STATUSES: readonly DocumentStatus[] = ['APPROVED', 'FINAL'];

export function isDocumentAuthoritative(status: DocumentStatus): boolean {
  return AUTHORITATIVE_DOCUMENT_STATUSES.includes(status);
}

/**
 * Whether a downstream document may be built on this one.
 *
 * Approved *and* current. An approved document whose own inputs have moved is
 * not a foundation for the next document — building on it would spread the
 * staleness one step further down the chain, quietly.
 */
export function isAuthoritativeState(state: DocumentState): boolean {
  return isDocumentAuthoritative(state.status) && state.currentness === 'CURRENT';
}

/**
 * Whether content may be edited.
 *
 * Issued documents may not, at any currentness: an issued document is what was
 * sent. An approved-but-stale document may — that is the whole point of telling
 * somebody it is stale.
 */
export function isDocumentEditable(status: DocumentStatus): boolean {
  return status === 'DRAFT' || status === 'NEEDS_REVISION' || status === 'APPROVED';
}

/** Whether a generation run may start. */
export function canGenerateDocument(status: DocumentStatus): boolean {
  return canTransitionDocument(status, 'QUEUED');
}

/**
 * Whether this document may be approved now.
 *
 * A stale document cannot be approved, whatever its status. Approval is a
 * statement that the content matches the project, and it does not.
 */
export function canApproveDocument(state: DocumentState): boolean {
  return state.currentness === 'CURRENT' && canTransitionDocument(state.status, 'APPROVED');
}

/**
 * Whether this document may be issued now.
 *
 * A previously issued document that has gone stale is a historical record, not a
 * candidate for issuing again — and it could not be, since `FINAL` has no exits.
 */
export function canIssueDocument(state: DocumentState): boolean {
  return state.currentness === 'CURRENT' && canTransitionDocument(state.status, 'FINAL');
}

/** Whether a run is in flight, so a second one must be refused. */
export function isDocumentRunning(status: DocumentStatus): boolean {
  return status === 'QUEUED' || status === 'GENERATING';
}
