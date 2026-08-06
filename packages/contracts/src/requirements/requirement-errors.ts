/**
 * Why a requirement source was refused, and what to tell the user about it.
 *
 * Two rules govern this file.
 *
 * **A rejection must be actionable.** "Invalid file" tells a user nothing they
 * can act on. "This file's contents do not match its .pdf extension" tells them
 * to check the file. Every message here names the problem and, where there is
 * one, the fix.
 *
 * **A rejection must not describe our internals.** No library names, no parser
 * messages, no paths, no limits we do not want probed. The real detail goes to
 * the structured log under the request's correlation id, where an operator can
 * find it and a caller cannot.
 */

export const REQUIREMENT_ERROR_CODES = {
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  LEGACY_FORMAT_UNAVAILABLE: 'LEGACY_FORMAT_UNAVAILABLE',
  MIME_MISMATCH: 'MIME_MISMATCH',
  SIGNATURE_MISMATCH: 'SIGNATURE_MISMATCH',
  UNSAFE_FILENAME: 'UNSAFE_FILENAME',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_EMPTY: 'FILE_EMPTY',
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  PROJECT_QUOTA_EXCEEDED: 'PROJECT_QUOTA_EXCEEDED',
  DUPLICATE_FILE: 'DUPLICATE_FILE',
  CORRUPTED_FILE: 'CORRUPTED_FILE',
  PASSWORD_PROTECTED: 'PASSWORD_PROTECTED',
  ARCHIVE_LIMIT_EXCEEDED: 'ARCHIVE_LIMIT_EXCEEDED',
  MALWARE_DETECTED: 'MALWARE_DETECTED',
  MALWARE_SCAN_UNAVAILABLE: 'MALWARE_SCAN_UNAVAILABLE',
  STORAGE_FAILURE: 'STORAGE_FAILURE',
  QUEUE_FAILURE: 'QUEUE_FAILURE',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  EXTRACTION_TIMEOUT: 'EXTRACTION_TIMEOUT',
  EXTRACTION_LIMIT_EXCEEDED: 'EXTRACTION_LIMIT_EXCEEDED',
  PARTIAL_EXTRACTION: 'PARTIAL_EXTRACTION',
  OCR_FAILED: 'OCR_FAILED',
  OCR_UNAVAILABLE: 'OCR_UNAVAILABLE',
  LOW_OCR_CONFIDENCE: 'LOW_OCR_CONFIDENCE',
  RETRY_LIMIT_REACHED: 'RETRY_LIMIT_REACHED',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SOURCE_DELETED: 'SOURCE_DELETED',
  SOURCE_NOT_RETRYABLE: 'SOURCE_NOT_RETRYABLE',
  CONTENT_NOT_AVAILABLE: 'CONTENT_NOT_AVAILABLE',
} as const;

export type RequirementErrorCode =
  (typeof REQUIREMENT_ERROR_CODES)[keyof typeof REQUIREMENT_ERROR_CODES];

export const REQUIREMENT_ERROR_MESSAGES: Readonly<Record<RequirementErrorCode, string>> = {
  UNSUPPORTED_FORMAT:
    'This file type is not supported. Upload a PDF, DOCX, TXT, CSV, XLSX, PNG, JPG or WEBP file.',
  LEGACY_FORMAT_UNAVAILABLE:
    'Legacy .doc and .xls files need conversion, which is not enabled on this deployment. Save the file as .docx or .xlsx and upload it again.',
  MIME_MISMATCH:
    "The file's declared type does not match its extension. Re-save the file in its proper format and try again.",
  SIGNATURE_MISMATCH:
    "The file's contents do not match its extension. It may be renamed, damaged, or not the format it claims to be.",
  UNSAFE_FILENAME:
    'That filename cannot be accepted. Rename the file using ordinary letters, numbers, spaces, hyphens and dots.',
  FILE_TOO_LARGE: 'This file is larger than the upload limit for a single file.',
  FILE_EMPTY: 'This file is empty. There is nothing to read from it.',
  TOO_MANY_FILES: 'This project already has the maximum number of requirement files.',
  PROJECT_QUOTA_EXCEEDED:
    'This upload would take the project past its total storage limit. Remove a source and try again.',
  DUPLICATE_FILE: 'An identical file is already attached to this project.',
  CORRUPTED_FILE: 'This file could not be read. It appears to be damaged or incomplete.',
  PASSWORD_PROTECTED:
    'This file is password-protected. Remove the password and upload it again — the password itself is never accepted or stored.',
  ARCHIVE_LIMIT_EXCEEDED:
    'This file expands to far more content than its size suggests, so it was not opened.',
  MALWARE_DETECTED: 'This file was rejected by the malware scan and has not been kept.',
  MALWARE_SCAN_UNAVAILABLE:
    'The malware scan could not run, so the file was not accepted. Please try again shortly.',
  STORAGE_FAILURE: 'The file could not be stored. Please try again.',
  QUEUE_FAILURE: 'The file was stored but could not be queued for reading. Use retry to try again.',
  EXTRACTION_FAILED: 'The content of this file could not be read.',
  EXTRACTION_TIMEOUT: 'Reading this file took too long and was stopped. Try a smaller file.',
  EXTRACTION_LIMIT_EXCEEDED:
    'This file contains more content than can be read in one pass. Split it and upload the parts.',
  PARTIAL_EXTRACTION:
    'Only part of this file could be read. Review what was extracted before relying on it.',
  OCR_FAILED: 'Text recognition failed for this file.',
  OCR_UNAVAILABLE:
    'Text recognition is not available on this deployment, so this file cannot be read.',
  LOW_OCR_CONFIDENCE:
    'Some recognised text is uncertain and is flagged for your review. Correct anything that is wrong before continuing.',
  RETRY_LIMIT_REACHED:
    'This source has been retried the maximum number of times. Delete it and upload it again.',
  SOURCE_NOT_FOUND: 'That requirement source could not be found in this project.',
  SOURCE_DELETED: 'That requirement source has been deleted.',
  SOURCE_NOT_RETRYABLE: 'Only a failed source can be retried.',
  CONTENT_NOT_AVAILABLE: 'This source has no extracted content yet.',
};

/**
 * Codes a retry could plausibly clear.
 *
 * The distinction is the whole point of a retry button: offering one for a
 * rejected file type invites a user to click it forever. These are the failures
 * caused by something transient — a storage blip, a worker dying — rather than
 * by the file itself.
 */
export const RETRYABLE_ERROR_CODES: readonly RequirementErrorCode[] = [
  REQUIREMENT_ERROR_CODES.STORAGE_FAILURE,
  REQUIREMENT_ERROR_CODES.QUEUE_FAILURE,
  REQUIREMENT_ERROR_CODES.EXTRACTION_FAILED,
  REQUIREMENT_ERROR_CODES.EXTRACTION_TIMEOUT,
  REQUIREMENT_ERROR_CODES.OCR_FAILED,
  REQUIREMENT_ERROR_CODES.MALWARE_SCAN_UNAVAILABLE,
];

export function isRetryableError(code: string): boolean {
  return (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);
}

export function requirementErrorMessage(code: RequirementErrorCode): string {
  return REQUIREMENT_ERROR_MESSAGES[code];
}
