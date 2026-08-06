import { HttpException } from '@nestjs/common';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  DEFAULT_ERROR_MESSAGES,
  type ApiErrorCode,
  type ApiErrorDetail,
} from '@wdrg/contracts';

export interface AppExceptionOptions {
  /** Overrides the default user-safe message for the code. */
  readonly message?: string;
  /** Field-level details. Only ever safe, caller-facing information. */
  readonly details?: readonly ApiErrorDetail[];
  /**
   * The underlying error. Logged with full detail, never serialised into the
   * HTTP response.
   */
  readonly cause?: unknown;
}

/**
 * Base class for every error the application raises deliberately.
 *
 * Carrying the machine-readable code on the exception is what lets the global
 * filter produce a consistent envelope without a pile of `instanceof` checks,
 * and what keeps internal detail (`cause`) separated from what the client sees.
 */
export class AppException extends HttpException {
  public readonly code: ApiErrorCode;
  public readonly details?: readonly ApiErrorDetail[];

  constructor(code: ApiErrorCode, options: AppExceptionOptions = {}) {
    const status = API_ERROR_STATUS[code];
    super(options.message ?? DEFAULT_ERROR_MESSAGES[code], status, { cause: options.cause });

    this.name = 'AppException';
    this.code = code;
    this.details = options.details;
  }
}

/* Convenience subclasses for the cases raised most often. Each exists so call
   sites read as domain intent rather than as HTTP plumbing. */

export class ValidationFailedException extends AppException {
  constructor(details: readonly ApiErrorDetail[], message?: string) {
    super(API_ERROR_CODES.VALIDATION_FAILED, { details, ...(message ? { message } : {}) });
    this.name = 'ValidationFailedException';
  }
}

export class ResourceNotFoundException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super(API_ERROR_CODES.NOT_FOUND, options);
    this.name = 'ResourceNotFoundException';
  }
}

export class ResourceConflictException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super(API_ERROR_CODES.CONFLICT, options);
    this.name = 'ResourceConflictException';
  }
}

export class ServiceUnavailableAppException extends AppException {
  constructor(options: AppExceptionOptions = {}) {
    super(API_ERROR_CODES.SERVICE_UNAVAILABLE, options);
    this.name = 'ServiceUnavailableAppException';
  }
}
