/**
 * Security-relevant events recorded against a project.
 *
 * The audit trail answers "what happened to this project, and when" for a
 * product with no accounts — where there is no user record to reason from. It
 * records the *fact* of an action, never the credential that authorised it: no
 * recovery secret, raw or hashed, ever reaches an audit document.
 */
export const AUDIT_EVENT_TYPES = [
  'PROJECT_CREATED',
  'PROJECT_RECOVERED',
  'PROJECT_RECOVERY_FAILED',
  'PROJECT_UPDATED',
  'TIMELINE_UPDATED',
  'START_DATE_UPDATED',
  'TEAM_CAPACITY_UPDATED',
  'OUTPUT_PREFERENCES_UPDATED',
  'PROJECT_SESSION_ENDED',
  'PROJECT_DELETION_REQUESTED',
  'PROJECT_DELETED',
  'PROJECT_ACCESS_DENIED',

  /* Phase 3 — requirement ingestion. Content itself never reaches an audit
     document; these record that something happened to a source, not what it
     said. */
  'REQUIREMENT_TEXT_ADDED',
  'REQUIREMENT_TEXT_UPDATED',
  'REQUIREMENT_FILE_UPLOADED',
  'REQUIREMENT_SOURCE_VALIDATED',
  'REQUIREMENT_SOURCE_REJECTED',
  'EXTRACTION_QUEUED',
  'EXTRACTION_STARTED',
  'EXTRACTION_COMPLETED',
  'EXTRACTION_FAILED',
  'OCR_STARTED',
  'OCR_COMPLETED',
  'OCR_FAILED',
  'EXTRACTED_CONTENT_CORRECTED',
  'EXTRACTED_CONTENT_RESTORED',
  'REQUIREMENT_SOURCE_REVIEWED',
  'REQUIREMENT_SOURCE_RETRIED',
  'REQUIREMENT_SOURCE_DELETED',
  'REQUIREMENT_FILE_DOWNLOADED',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * Why an access attempt was refused.
 *
 * Recorded internally at this granularity so an operator can distinguish a
 * mistyped link from a probe. The API response deliberately does **not** make
 * this distinction — see `project-errors.ts`.
 */
export const ACCESS_DENIED_REASONS = [
  'UNKNOWN_PROJECT',
  'SECRET_MISMATCH',
  'PROJECT_EXPIRED',
  'PROJECT_DELETED',
  'NO_SESSION',
  'SESSION_EXPIRED',
  'SESSION_PROJECT_MISMATCH',
  'CSRF_FAILED',
] as const;

export type AccessDeniedReason = (typeof ACCESS_DENIED_REASONS)[number];
