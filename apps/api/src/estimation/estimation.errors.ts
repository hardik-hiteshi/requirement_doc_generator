import {
  API_ERROR_CODES,
  ESTIMATION_ERROR_MESSAGES,
  type ApiErrorCode,
  type EstimationErrorCode,
} from '@wdrg/contracts';

import { AppException } from '../common/errors';

/**
 * A Phase 6 refusal, as an exception the global filter already understands.
 *
 * Identical in shape to `AnalysisError` and `StackError`, deliberately: a caller
 * parsing error envelopes should not have to learn a third format because the
 * phase changed. The `detail` payload carries structured, caller-facing
 * information only — the blocker list on a refused approval, so the browser can
 * show what to fix.
 */
export class EstimationError extends AppException {
  readonly estimationCode: EstimationErrorCode;

  constructor(
    code: EstimationErrorCode,
    status: 404 | 409 | 422 | 503,
    reason?: string,
    payload?: Record<string, unknown>,
  ) {
    super(apiCodeFor(status), {
      message:
        reason === 'version_conflict'
          ? 'This changed elsewhere since you loaded it. Reload before saving again.'
          : ESTIMATION_ERROR_MESSAGES[code],
      details: payload
        ? [{ path: 'estimation', rule: code, message: JSON.stringify(payload) }]
        : [{ path: '', rule: code, message: ESTIMATION_ERROR_MESSAGES[code] }],
    });

    this.name = 'EstimationError';
    this.estimationCode = code;
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
