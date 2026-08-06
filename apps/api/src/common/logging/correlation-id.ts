import { randomUUID } from 'node:crypto';

import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER, normalizeCorrelationId } from '@wdrg/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Resolves the correlation id for a request and echoes it on the response.
 *
 * An id supplied by the caller is reused so a trace spans the browser, any
 * gateway and the API — but only after validation. An unvalidated header would
 * let a caller inject newlines into every log line this request produces, or
 * poison a log search with an id belonging to someone else's request.
 */
export function resolveCorrelationId(request: IncomingMessage): string {
  const candidates = [request.headers[REQUEST_ID_HEADER], request.headers[CORRELATION_ID_HEADER]];

  for (const candidate of candidates) {
    // Node lower-cases header names but a repeated header arrives as an array.
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    const normalized = normalizeCorrelationId(value);

    if (normalized) {
      return normalized;
    }
  }

  return randomUUID();
}

/**
 * Builds the `genReqId` function pino-http calls once per request.
 *
 * Doing this in `genReqId` rather than in a middleware guarantees the id exists
 * before the first log line is written, including for requests that never reach
 * a route (404s, body-size rejections).
 */
export function createRequestIdFactory() {
  return function genReqId(request: IncomingMessage, response: ServerResponse): string {
    const correlationId = resolveCorrelationId(request);
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    return correlationId;
  };
}
