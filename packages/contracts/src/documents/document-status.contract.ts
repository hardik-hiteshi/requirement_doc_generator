import { z } from 'zod';

/**
 * A controlled document's lifecycle.
 *
 * Ten states, and two of them are routinely conflated by document systems that
 * later cannot answer a simple question.
 *
 * **`APPROVED` is not `FINAL`.** Approved means the content is agreed and
 * downstream documents may build on it. Final means it has been issued — it left
 * the building. An approved document can be reopened and revised; a final one is
 * a matter of record, and the only way past it is a new version. Collapsing the
 * two makes "which version did the client actually receive?" unanswerable.
 *
 * **`OUTDATED` is not `NEEDS_REVISION`.** Outdated is a statement about the
 * world: something upstream moved, and this document no longer reflects it.
 * Needs-revision is a statement about the content: a person read it and wants it
 * changed. The first is detected, the second is chosen.
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
  /** An authoritative input changed after approval. Content is unchanged. */
  'OUTDATED',
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
  OUTDATED: 'Out of date',
  FINAL: 'Issued',
  FAILED: 'Failed',
};

/**
 * Every legal move, and nothing else.
 *
 * Written as a table rather than as conditionals in a service, so the rules can
 * be read in one place and tested without a database.
 *
 * `FINAL` has no exits. That is the point of it: reissuing means a new version,
 * which is a new document record, not a state change on this one.
 */
export const DOCUMENT_TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  NOT_STARTED: ['QUEUED'],
  QUEUED: ['GENERATING', 'FAILED'],
  GENERATING: ['DRAFT', 'FAILED'],
  DRAFT: ['QUEUED', 'DRAFT', 'NEEDS_REVISION', 'APPROVED', 'OUTDATED'],
  NEEDS_REVISION: ['QUEUED', 'DRAFT', 'NEEDS_REVISION', 'APPROVED', 'OUTDATED'],
  APPROVED: ['DRAFT', 'NEEDS_REVISION', 'OUTDATED', 'FINAL'],
  /*
   * An outdated document is still readable and still editable — what it is not
   * is current. Regenerating or editing takes it back to DRAFT; approving it
   * again requires going through DRAFT, so nobody re-approves stale content in
   * one click.
   */
  OUTDATED: ['QUEUED', 'DRAFT', 'NEEDS_REVISION'],
  FINAL: [],
  FAILED: ['QUEUED', 'NOT_STARTED'],
};

export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return DOCUMENT_TRANSITIONS[from].includes(to);
}

/** Statuses where a downstream document may treat this one as authority. */
export const AUTHORITATIVE_DOCUMENT_STATUSES: readonly DocumentStatus[] = ['APPROVED', 'FINAL'];

export function isDocumentAuthoritative(status: DocumentStatus): boolean {
  return AUTHORITATIVE_DOCUMENT_STATUSES.includes(status);
}

/** Whether content may be edited. Issued documents may not. */
export function isDocumentEditable(status: DocumentStatus): boolean {
  return (
    status === 'DRAFT' ||
    status === 'NEEDS_REVISION' ||
    status === 'OUTDATED' ||
    status === 'APPROVED'
  );
}

/** Whether a generation run may start. */
export function canGenerateDocument(status: DocumentStatus): boolean {
  return canTransitionDocument(status, 'QUEUED');
}

/** Whether a run is in flight, so a second one must be refused. */
export function isDocumentRunning(status: DocumentStatus): boolean {
  return status === 'QUEUED' || status === 'GENERATING';
}
