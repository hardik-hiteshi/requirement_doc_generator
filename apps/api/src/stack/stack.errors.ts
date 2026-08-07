import {
  API_ERROR_CODES,
  STACK_ERROR_MESSAGES,
  type ApiErrorCode,
  type StackErrorCode,
} from '@wdrg/contracts';

import { AppException } from '../common/errors';

/**
 * A Phase 5 refusal, as an exception the global filter already understands.
 *
 * Identical in shape to `AnalysisError`, and deliberately so: a caller parsing
 * error envelopes should not have to learn a second format because the phase
 * changed. The `detail` payload carries structured, caller-facing information
 * only — the blocker list on a refused approval, so the browser can show what
 * to fix rather than making the user go and find out.
 */
export class StackError extends AppException {
  readonly stackCode: StackErrorCode;

  constructor(
    code: StackErrorCode,
    status: 404 | 409 | 422 | 503,
    reason?: string,
    payload?: Record<string, unknown>,
  ) {
    super(apiCodeFor(status), {
      message:
        reason === 'version_conflict'
          ? 'This changed elsewhere since you loaded it. Reload before saving again.'
          : STACK_ERROR_MESSAGES[code],
      details: payload
        ? [{ path: 'stack', rule: code, message: JSON.stringify(payload) }]
        : [{ path: '', rule: code, message: STACK_ERROR_MESSAGES[code] }],
    });

    this.name = 'StackError';
    this.stackCode = code;
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
