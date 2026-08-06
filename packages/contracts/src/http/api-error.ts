import { z } from 'zod';

/**
 * Machine-readable error codes.
 *
 * The set is intentionally small in Phase 1 and grows as features land. Codes
 * are stable identifiers — clients branch on them, so they must never be renamed
 * without a version bump.
 */
export const API_ERROR_CODES = {
  /** Request failed schema/shape validation. `details` carries field errors. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Malformed request that is not a field-level validation failure. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** No credential / session presented, or it was rejected. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated, but not allowed to touch this resource. */
  FORBIDDEN: 'FORBIDDEN',
  /** Resource does not exist, or the caller may not know that it does. */
  NOT_FOUND: 'NOT_FOUND',
  /** Request conflicts with current state (version mismatch, duplicate). */
  CONFLICT: 'CONFLICT',
  /** Payload exceeded a configured size limit. */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** Caller exceeded a rate or usage quota. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** A dependency (database, storage, AI provider) is unavailable. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Anything unexpected. The message is always generic for this code. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export const apiErrorCodeSchema = z.enum(
  Object.values(API_ERROR_CODES) as [ApiErrorCode, ...ApiErrorCode[]],
);

/** Canonical HTTP status for each error code. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  [API_ERROR_CODES.VALIDATION_FAILED]: 422,
  [API_ERROR_CODES.BAD_REQUEST]: 400,
  [API_ERROR_CODES.UNAUTHORIZED]: 401,
  [API_ERROR_CODES.FORBIDDEN]: 403,
  [API_ERROR_CODES.NOT_FOUND]: 404,
  [API_ERROR_CODES.CONFLICT]: 409,
  [API_ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [API_ERROR_CODES.RATE_LIMITED]: 429,
  [API_ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
  [API_ERROR_CODES.INTERNAL_ERROR]: 500,
};

/**
 * A single field-level problem. Used for validation failures so a form can map
 * the failure back to the input that caused it.
 */
export const apiErrorDetailSchema = z.object({
  /** Dot/bracket path to the offending field, e.g. `timeline.durationDays`. */
  path: z.string(),
  /** Safe, human-readable explanation. Never contains internal identifiers. */
  message: z.string(),
  /** Stable sub-code for programmatic handling, when one applies. */
  rule: z.string().optional(),
});

export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;

/**
 * The one and only error envelope the API returns. Every non-2xx response body
 * conforms to this shape — no stack traces, no provider payloads, no internal
 * identifiers.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    status: z.number().int(),
    /** Correlation id for support: matches the response header and the logs. */
    correlationId: z.string(),
    /** ISO-8601 timestamp of when the error was produced. */
    timestamp: z.string(),
    /** Request path that produced the error. */
    path: z.string(),
    /** Field-level details. Present for validation failures. */
    details: z.array(apiErrorDetailSchema).optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Narrowing guard for unknown response bodies on the client. */
export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return apiErrorResponseSchema.safeParse(value).success;
}

/**
 * Default user-safe message per code. Handlers may override with a more specific
 * message, but must never leak internals — see `INTERNAL_ERROR`, which is always
 * generic regardless of the underlying cause.
 */
export const DEFAULT_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  [API_ERROR_CODES.VALIDATION_FAILED]: 'The submitted data is invalid.',
  [API_ERROR_CODES.BAD_REQUEST]: 'The request could not be processed.',
  [API_ERROR_CODES.UNAUTHORIZED]: 'Access to this project could not be verified.',
  [API_ERROR_CODES.FORBIDDEN]: 'You do not have access to this resource.',
  [API_ERROR_CODES.NOT_FOUND]: 'The requested resource was not found.',
  [API_ERROR_CODES.CONFLICT]: 'The resource was modified by another request.',
  [API_ERROR_CODES.PAYLOAD_TOO_LARGE]: 'The submitted content exceeds the allowed size.',
  [API_ERROR_CODES.RATE_LIMITED]: 'Too many requests. Please retry shortly.',
  [API_ERROR_CODES.SERVICE_UNAVAILABLE]: 'A required service is temporarily unavailable.',
  [API_ERROR_CODES.INTERNAL_ERROR]: 'An unexpected error occurred. Please try again.',
};
