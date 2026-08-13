import {
  CORRELATION_ID_HEADER,
  isApiErrorResponse,
  type ApiErrorCode,
  type ApiErrorDetail,
} from '@wdrg/contracts';

import { publicEnv } from './env';

/**
 * A failed API call, normalised.
 *
 * Every failure — HTTP error, network drop, unparseable body — arrives as this
 * one type, so UI code branches on `code` instead of re-deriving what went wrong
 * from a status number at each call site.
 */
export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
    public readonly details?: readonly ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** True when a retry could plausibly succeed without the user changing anything. */
  get isRetryable(): boolean {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'SERVICE_UNAVAILABLE' ||
      this.code === 'INTERNAL_ERROR' ||
      this.code === 'RATE_LIMITED'
    );
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  readonly body?: unknown;
  /**
   * A body the browser must serialise itself, such as `FormData`.
   *
   * Sent as-is and with no `Content-Type`, because multipart needs a boundary the
   * browser generates — naming the type here would replace it with one that has none.
   */
  readonly rawBody?: BodyInit;
  /** Aborts the request after this many milliseconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Calls the API and returns the parsed body, or throws `ApiClientError`.
 *
 * Cookies are always sent: project access is carried by an HttpOnly session
 * cookie, never by a token the client-side code could read or accidentally log.
 */
export async function apiFetch<TResponse>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<TResponse> {
  const { body, rawBody, timeoutMs = DEFAULT_TIMEOUT_MS, headers, signal, ...rest } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;

  try {
    response = await fetch(`${publicEnv.NEXT_PUBLIC_API_BASE_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined || rawBody !== undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(rawBody !== undefined
        ? { body: rawBody }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    });
  } catch {
    // The browser deliberately hides the reason a cross-origin fetch failed, so
    // there is nothing more specific to report than "unreachable".
    throw new ApiClientError(
      'NETWORK_ERROR',
      'The service could not be reached. Check your connection and try again.',
      0,
    );
  } finally {
    clearTimeout(timeout);
  }

  const correlationId = response.headers.get(CORRELATION_ID_HEADER) ?? undefined;
  const payload: unknown = response.status === 204 ? null : await parseJson(response);

  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw new ApiClientError(
        payload.error.code,
        payload.error.message,
        response.status,
        payload.error.correlationId,
        payload.error.details,
      );
    }

    // A non-conforming error body means something upstream of the API answered
    // (proxy, gateway). Surface a safe message rather than rendering raw output.
    throw new ApiClientError(
      'INTERNAL_ERROR',
      'An unexpected error occurred. Please try again.',
      response.status,
      correlationId,
    );
  }

  return payload as TResponse;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
