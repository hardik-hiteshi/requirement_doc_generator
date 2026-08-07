import {
  analysisErrorMessage,
  API_ERROR_CODES,
  type AnalysisErrorCode,
  type ApiErrorCode,
} from '@wdrg/contracts';

import { AppException } from '../common/errors';

/**
 * A Phase 4 refusal, as an exception the global filter already understands.
 *
 * Carrying the analysis code separately from the HTTP code means a call site
 * reads as domain intent — "this baseline has blockers" — while the response
 * envelope stays identical to every other error in the application.
 *
 * The `detail` payload is for structured, caller-facing information only: the
 * blocker list on a refused approval, so the browser can show *what* to fix
 * rather than making the user go and find out. Nothing internal goes in it.
 */
export class AnalysisError extends AppException {
  readonly analysisCode: AnalysisErrorCode;

  constructor(
    code: AnalysisErrorCode,
    status: 404 | 409 | 422 | 503,
    reason?: string,
    payload?: Record<string, unknown>,
  ) {
    super(apiCodeFor(status), {
      message:
        reason === 'version_conflict'
          ? 'This changed elsewhere since you loaded it. Reload before saving again.'
          : analysisErrorMessage(code),
      details: payload
        ? [{ path: 'baseline', rule: code, message: JSON.stringify(payload) }]
        : [{ path: '', rule: code, message: analysisErrorMessage(code) }],
    });

    this.name = 'AnalysisError';
    this.analysisCode = code;
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
