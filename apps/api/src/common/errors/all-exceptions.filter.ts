import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  API_ERROR_CODES,
  CORRELATION_ID_HEADER,
  DEFAULT_ERROR_MESSAGES,
  METRIC_NAMES,
  type ApiErrorCode,
  type ApiErrorDetail,
  type ApiErrorResponse,
} from '@wdrg/contracts';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

import { MetricsService } from '../../observability/metrics.service';
import { AppException } from './app.exception';

/** HTTP status -> error code, for exceptions raised by Nest itself. */
const STATUS_TO_CODE: Readonly<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: API_ERROR_CODES.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: API_ERROR_CODES.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: API_ERROR_CODES.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: API_ERROR_CODES.NOT_FOUND,
  [HttpStatus.CONFLICT]: API_ERROR_CODES.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: API_ERROR_CODES.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: API_ERROR_CODES.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: API_ERROR_CODES.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: API_ERROR_CODES.SERVICE_UNAVAILABLE,
};

interface ResolvedError {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
}

/**
 * Converts every thrown value into the single API error envelope.
 *
 * Two rules drive this filter:
 *  1. The client never sees internals. Stack traces, driver messages, provider
 *     responses and file paths stay in the logs.
 *  2. Every response carries the correlation id, so a user can quote it and an
 *     operator can find the matching structured log line.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /**
   * Optional, and injected rather than imported, so this filter keeps working in the
   * unit tests that construct it directly. Counting failures is useful; making the
   * one component that must never throw depend on another is not.
   */
  constructor(@Optional() private readonly metrics?: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const resolved = this.resolve(exception);
    const correlationId = this.correlationIdOf(request, response);

    const body: ApiErrorResponse = {
      error: {
        code: resolved.code,
        message: resolved.message,
        status: resolved.status,
        correlationId,
        timestamp: new Date().toISOString(),
        path: request.originalUrl ?? request.url ?? '',
        ...(resolved.details && resolved.details.length > 0
          ? { details: [...resolved.details] }
          : {}),
      },
    };

    /*
     * Counted by code, so "is anything failing right now" is a scrape rather than a
     * log search. The code is a closed set from the error contract, so this cannot
     * grow unbounded — and it is deliberately not labelled by path, which would.
     */
    this.metrics?.increment(METRIC_NAMES.errorsTotal, { code: resolved.code });

    this.log(exception, resolved, correlationId, request);

    if (response.headersSent) {
      // The response has already started streaming; the only safe action left is
      // to end it. Overwriting would corrupt the payload.
      response.end();
      return;
    }

    response.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: 422,
        code: API_ERROR_CODES.VALIDATION_FAILED,
        message: DEFAULT_ERROR_MESSAGES[API_ERROR_CODES.VALIDATION_FAILED],
        details: toDetails(exception),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? this.fallbackCodeForStatus(status);

      return {
        status,
        code,
        // Nest's built-in messages ("Cannot GET /x", "Unauthorized") are safe;
        // anything at 5xx is replaced with the generic message.
        message: status >= 500 ? DEFAULT_ERROR_MESSAGES[code] : this.messageOf(exception, code),
        ...(this.detailsOf(exception) ? { details: this.detailsOf(exception) } : {}),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: API_ERROR_CODES.INTERNAL_ERROR,
      message: DEFAULT_ERROR_MESSAGES[API_ERROR_CODES.INTERNAL_ERROR],
    };
  }

  private fallbackCodeForStatus(status: number): ApiErrorCode {
    if (status >= 500) {
      return API_ERROR_CODES.INTERNAL_ERROR;
    }

    return API_ERROR_CODES.BAD_REQUEST;
  }

  private messageOf(exception: HttpException, code: ApiErrorCode): string {
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return response;
    }

    if (isRecord(response) && typeof response.message === 'string') {
      return response.message;
    }

    return DEFAULT_ERROR_MESSAGES[code];
  }

  /**
   * Nest's built-in ValidationPipe reports failures as `message: string[]`.
   * Those strings are safe and useful, so they are surfaced as details.
   */
  private detailsOf(exception: HttpException): readonly ApiErrorDetail[] | undefined {
    const response = exception.getResponse();

    if (!isRecord(response) || !Array.isArray(response.message)) {
      return undefined;
    }

    const messages = response.message.filter((item): item is string => typeof item === 'string');

    return messages.length > 0 ? messages.map((message) => ({ path: '', message })) : undefined;
  }

  private correlationIdOf(request: Request, response: Response): string {
    const fromRequest = (request as Request & { id?: unknown }).id;

    if (typeof fromRequest === 'string' && fromRequest.length > 0) {
      return fromRequest;
    }

    const fromHeader = response.getHeader(CORRELATION_ID_HEADER);
    return typeof fromHeader === 'string' ? fromHeader : 'unknown';
  }

  private log(
    exception: unknown,
    resolved: ResolvedError,
    correlationId: string,
    request: Request,
  ): void {
    const context = {
      correlationId,
      code: resolved.code,
      status: resolved.status,
      method: request.method,
      path: request.originalUrl ?? request.url,
    };

    // 5xx means we failed; log the full error, including the stack, so the cause
    // is recoverable from logs alone. 4xx is the caller's problem: record it at
    // warn level without the noise of a stack trace.
    if (resolved.status >= 500) {
      this.logger.error(
        { ...context, err: serializeError(exception) },
        'Request failed with an unhandled error',
      );
      return;
    }

    this.logger.warn(context, 'Request rejected');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toDetails(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    rule: issue.code,
  }));
}

function serializeError(exception: unknown): Record<string, unknown> {
  if (exception instanceof Error) {
    return {
      name: exception.name,
      message: exception.message,
      stack: exception.stack,
      ...(exception.cause === undefined ? {} : { cause: describeUnknown(exception.cause) }),
    };
  }

  return { name: 'NonError', message: describeUnknown(exception) };
}

/**
 * Describes an arbitrary thrown value for the log.
 *
 * A bare `String(value)` on an object yields `[object Object]`, which is the
 * least useful thing a log line can say about a failure.
 */
function describeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      // Circular structure, or a toJSON that throws.
      return Object.prototype.toString.call(value);
    }
  }

  return String(value);
}
