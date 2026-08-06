/**
 * Header names shared by the API and every client.
 *
 * The correlation id is generated (or accepted) by the API edge and echoed on
 * every response and every structured log line, so a user-reported error can be
 * traced end to end without exposing internals.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id' as const;

/**
 * Inbound request id. If a caller (gateway, load balancer, browser client)
 * supplies one, the API adopts it as the correlation id instead of minting a new
 * one. Values are validated before being trusted — see the API's correlation-id
 * middleware.
 */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

/**
 * Maximum accepted length of a caller-supplied correlation id. Anything longer,
 * or containing characters outside the allowed set, is discarded and replaced
 * with a server-generated id (log-injection defence).
 */
export const CORRELATION_ID_MAX_LENGTH = 128;

/** Correlation ids must be printable ASCII without control characters. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the supplied value when it is a safe correlation id, otherwise `null`.
 *
 * A value containing a control character is rejected outright rather than
 * stripped. Sanitising it would mean accepting an id that differs from the one
 * the caller sent — so a deliberate log-injection attempt would silently succeed
 * at getting *something* accepted, and a legitimate caller's trace id would
 * diverge from ours with nothing recorded. Surrounding spaces are a formatting
 * artefact and are trimmed.
 */
export function normalizeCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    return null;
  }

  const trimmed = value.trim();
  return CORRELATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}
