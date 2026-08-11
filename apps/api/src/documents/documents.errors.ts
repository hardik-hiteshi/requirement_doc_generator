import {
  API_ERROR_CODES,
  DOCUMENT_ERROR_MESSAGES,
  type ApiErrorCode,
  type DocumentErrorCode,
} from '@wdrg/contracts';

import { AppException } from '../common/errors';

/**
 * A Phase 7 refusal, as an exception the global filter already understands.
 *
 * Identical in shape to `AnalysisError`, `StackError` and `EstimationError`,
 * deliberately: a caller parsing error envelopes should not have to learn a
 * fourth format because the phase changed.
 *
 * The message lives in `@wdrg/contracts`, so the browser can show the same words
 * without a round trip and there is exactly one wording per refusal.
 */
export class DocumentError extends AppException {
  readonly documentCode: DocumentErrorCode;

  constructor(
    code: DocumentErrorCode,
    status: 404 | 409 | 422 | 503,
    reason?: string,
    payload?: Record<string, unknown>,
  ) {
    super(apiCodeFor(status), {
      message:
        reason === 'version_conflict'
          ? 'This changed elsewhere since you loaded it. Reload before saving again.'
          : DOCUMENT_ERROR_MESSAGES[code],
      details: payload
        ? [{ path: 'documents', rule: code, message: JSON.stringify(payload) }]
        : [{ path: '', rule: code, message: DOCUMENT_ERROR_MESSAGES[code] }],
    });

    this.name = 'DocumentError';
    this.documentCode = code;
  }
}

function apiCodeFor(status: 404 | 409 | 422 | 503): ApiErrorCode {
  switch (status) {
    case 404:
      return API_ERROR_CODES.NOT_FOUND;
    case 409:
      return API_ERROR_CODES.CONFLICT;
    case 422:
      return API_ERROR_CODES.VALIDATION_FAILED;
    case 503:
      return API_ERROR_CODES.SERVICE_UNAVAILABLE;
  }
}
