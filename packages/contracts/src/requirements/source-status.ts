/**
 * The requirement-source lifecycle.
 *
 * A source moves through validation, queuing, extraction and review. The states
 * are explicit rather than a pair of booleans because the UI has to say *what*
 * is happening — "checking the file" and "reading page 4" are different waits,
 * and a user staring at a spinner deserves to know which one they are in.
 *
 * The transition table is the authority. Every write goes through
 * `canTransition`, so a stage cannot be skipped by a caller that forgot a check.
 */
export const SOURCE_STATUSES = [
  /** Bytes are still arriving. Only ever set for file sources. */
  'UPLOADING',
  /** Bytes are stored. Nothing has looked at them yet. */
  'UPLOADED',
  /** Filename, size, extension, MIME, signature and malware checks. */
  'VALIDATING',
  /** Accepted, waiting for a worker. */
  'QUEUED',
  /** A worker is reading the file. */
  'EXTRACTING',
  /** No usable text layer; OCR is the only way to read it. */
  'OCR_REQUIRED',
  'OCR_PROCESSING',
  /** Extracted, but something needs a human: low confidence, or warnings. */
  'REVIEW_REQUIRED',
  /** Extracted and either clean or reviewed. Usable by later phases. */
  'READY',
  'FAILED',
  'DELETED',
] as const;

export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * Permitted transitions.
 *
 * `FAILED` is reachable from every working state and is *not* terminal — retry
 * is a first-class operation, so it goes back to `QUEUED`. `DELETED` is the only
 * state with no way out.
 */
export const SOURCE_STATUS_TRANSITIONS: Readonly<Record<SourceStatus, readonly SourceStatus[]>> = {
  UPLOADING: ['UPLOADED', 'FAILED', 'DELETED'],
  UPLOADED: ['VALIDATING', 'FAILED', 'DELETED'],
  VALIDATING: ['QUEUED', 'FAILED', 'DELETED'],
  QUEUED: ['EXTRACTING', 'FAILED', 'DELETED'],
  EXTRACTING: ['OCR_REQUIRED', 'REVIEW_REQUIRED', 'READY', 'FAILED', 'DELETED'],
  OCR_REQUIRED: ['OCR_PROCESSING', 'FAILED', 'DELETED'],
  OCR_PROCESSING: ['REVIEW_REQUIRED', 'READY', 'FAILED', 'DELETED'],
  // A reviewed source becomes READY; a further edit sends it back for review.
  REVIEW_REQUIRED: ['READY', 'QUEUED', 'FAILED', 'DELETED'],
  READY: ['REVIEW_REQUIRED', 'QUEUED', 'DELETED'],
  FAILED: ['QUEUED', 'DELETED'],
  DELETED: [],
};

export function canTransitionSource(from: SourceStatus, to: SourceStatus): boolean {
  // Staying put is always valid. Marking a cleanly-extracted source as reviewed
  // changes its *review* status while it remains READY, and a table that
  // rejected that would make "review a source that needed no correction"
  // impossible — which is the common case, not an edge one.
  if (from === to) {
    return true;
  }

  return SOURCE_STATUS_TRANSITIONS[from].includes(to);
}

/** Whether the source is still being worked on, so the UI keeps polling. */
export function isSourceInProgress(status: SourceStatus): boolean {
  return (
    status === 'UPLOADING' ||
    status === 'UPLOADED' ||
    status === 'VALIDATING' ||
    status === 'QUEUED' ||
    status === 'EXTRACTING' ||
    status === 'OCR_REQUIRED' ||
    status === 'OCR_PROCESSING'
  );
}

/** Whether extracted content exists and can be shown. */
export function hasExtractedContent(status: SourceStatus): boolean {
  return status === 'REVIEW_REQUIRED' || status === 'READY';
}

/** Whether the source may be retried. `READY` is excluded — nothing to fix. */
export function isRetryable(status: SourceStatus): boolean {
  return status === 'FAILED';
}

export function isSourceDeleted(status: SourceStatus): boolean {
  return status === 'DELETED';
}

/**
 * The stage a retry resumes from.
 *
 * A file that failed during OCR does not need re-uploading or re-validating —
 * those results are still on the record. Restarting from the beginning would
 * throw away completed work and, for a large scan, a lot of wall-clock time.
 */
export type RetryStage = 'validation' | 'extraction' | 'ocr';

export const SOURCE_STATUS_LABELS: Readonly<Record<SourceStatus, string>> = {
  UPLOADING: 'Uploading',
  UPLOADED: 'Uploaded',
  VALIDATING: 'Checking the file',
  QUEUED: 'Waiting to be read',
  EXTRACTING: 'Reading the content',
  OCR_REQUIRED: 'Needs text recognition',
  OCR_PROCESSING: 'Recognising text',
  REVIEW_REQUIRED: 'Needs your review',
  READY: 'Ready',
  FAILED: 'Failed',
  DELETED: 'Deleted',
};
