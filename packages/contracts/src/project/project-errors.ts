import { API_ERROR_CODES, type ApiErrorCode } from '../http/api-error';

/**
 * How project access failures are reported.
 *
 * **Every failure to reach a project returns the same code and message**,
 * whether the project never existed, the secret was wrong, the project expired
 * or it was deleted. Distinguishing them would turn the API into an oracle: a
 * caller could confirm which project ids exist by comparing responses, which is
 * exactly the enumeration the unguessable identifier is meant to prevent.
 *
 * The real reason is recorded in the audit trail and the structured logs, where
 * an operator can see it and an attacker cannot.
 */
export const PROJECT_ACCESS_DENIED_CODE: ApiErrorCode = API_ERROR_CODES.UNAUTHORIZED;

export const PROJECT_ACCESS_DENIED_MESSAGE =
  'This project could not be opened. The recovery link may be incorrect, or the project may have expired or been deleted.' as const;

/** Returned when the caller has a valid session but the project is unusable. */
export const PROJECT_NOT_MODIFIABLE_MESSAGE =
  'This project can no longer be modified because it has expired or been deleted.' as const;

/**
 * Returned when the submitted version is not the current one — someone else
 * saved first, or this tab has been open a while.
 */
export const PROJECT_VERSION_CONFLICT_MESSAGE =
  'This project was changed elsewhere since you loaded it. Reload to see the latest version before saving again.' as const;

export const CSRF_FAILED_MESSAGE =
  'The request could not be verified. Reload the page and try again.' as const;
