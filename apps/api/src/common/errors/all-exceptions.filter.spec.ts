import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  type Logger,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import { API_ERROR_CODES, apiErrorResponseSchema } from '@wdrg/contracts';
import { z } from 'zod';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException, ValidationFailedException } from './app.exception';

interface Captured {
  status: number;
  body: unknown;
}

function createHost(overrides: { id?: string; url?: string; headersSent?: boolean } = {}) {
  const captured: Captured = { status: 0, body: undefined };
  const end = jest.fn();

  const response = {
    headersSent: overrides.headersSent ?? false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
    getHeader: () => undefined,
    end,
  };

  const request = {
    id: overrides.id ?? 'corr-test-1234',
    method: 'POST',
    url: overrides.url ?? '/api/v1/projects',
    originalUrl: overrides.url ?? '/api/v1/projects',
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured, end };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  /** The logger is private by design; tests reach it through one typed helper. */
  const loggerOf = (instance: AllExceptionsFilter): Logger =>
    (instance as unknown as { logger: Logger }).logger;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    // The filter logs deliberately; silence it so suite output stays readable.
    jest.spyOn(loggerOf(filter), 'error').mockImplementation(() => undefined);
    jest.spyOn(loggerOf(filter), 'warn').mockImplementation(() => undefined);
  });

  it('produces an envelope that satisfies the shared contract', () => {
    const { host, captured } = createHost();

    filter.catch(new NotFoundException('Project not found'), host);

    expect(apiErrorResponseSchema.safeParse(captured.body).success).toBe(true);
  });

  it('maps an AppException to its declared code and status', () => {
    const { host, captured } = createHost();

    filter.catch(new AppException(API_ERROR_CODES.CONFLICT, { message: 'Version mismatch' }), host);

    expect(captured.status).toBe(HttpStatus.CONFLICT);
    expect(captured.body).toMatchObject({
      error: { code: API_ERROR_CODES.CONFLICT, message: 'Version mismatch', status: 409 },
    });
  });

  it('carries field details for validation failures', () => {
    const { host, captured } = createHost();

    filter.catch(
      new ValidationFailedException([
        { path: 'projectName', message: 'Project name is required.', rule: 'required' },
      ]),
      host,
    );

    expect(captured.status).toBe(422);
    expect(captured.body).toMatchObject({
      error: {
        code: API_ERROR_CODES.VALIDATION_FAILED,
        details: [{ path: 'projectName', rule: 'required' }],
      },
    });
  });

  it('converts a ZodError into field-level details', () => {
    const { host, captured } = createHost();
    const schema = z.object({ timeline: z.object({ durationDays: z.number().int().positive() }) });
    const result = schema.safeParse({ timeline: { durationDays: -1 } });

    expect(result.success).toBe(false);
    filter.catch(result.success ? new Error('unreachable') : result.error, host);

    expect(captured.status).toBe(422);
    expect(captured.body).toMatchObject({
      error: {
        code: API_ERROR_CODES.VALIDATION_FAILED,
        details: [{ path: 'timeline.durationDays' }],
      },
    });
  });

  it.each([
    [new BadRequestException('Bad payload'), 400, API_ERROR_CODES.BAD_REQUEST],
    [new ForbiddenException(), 403, API_ERROR_CODES.FORBIDDEN],
    [new NotFoundException(), 404, API_ERROR_CODES.NOT_FOUND],
  ])('maps built-in %# to the correct code', (exception, status, code) => {
    const { host, captured } = createHost();

    filter.catch(exception, host);

    expect(captured.status).toBe(status);
    expect(captured.body).toMatchObject({ error: { code } });
  });

  it('never leaks internal detail from an unexpected error', () => {
    const { host, captured } = createHost();
    const leaky = new Error('MongoServerError: Authentication failed for user "admin"');

    filter.catch(leaky, host);

    expect(captured.status).toBe(500);
    const serialized = JSON.stringify(captured.body);
    expect(serialized).not.toContain('MongoServerError');
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('stack');
    expect(captured.body).toMatchObject({
      error: {
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: expect.stringContaining('unexpected'),
      },
    });
  });

  it('replaces the message of a 5xx HttpException with the generic one', () => {
    const { host, captured } = createHost();

    filter.catch(
      new HttpException('Upstream provider returned key sk-live-123', HttpStatus.BAD_GATEWAY),
      host,
    );

    expect(captured.status).toBe(HttpStatus.BAD_GATEWAY);
    expect(JSON.stringify(captured.body)).not.toContain('sk-live-123');
  });

  it('echoes the correlation id from the request', () => {
    const { host, captured } = createHost({ id: 'corr-abc-999' });

    filter.catch(new NotFoundException(), host);

    expect(captured.body).toMatchObject({ error: { correlationId: 'corr-abc-999' } });
  });

  it('records the request path', () => {
    const { host, captured } = createHost({ url: '/api/v1/projects/42' });

    filter.catch(new NotFoundException(), host);

    expect(captured.body).toMatchObject({ error: { path: '/api/v1/projects/42' } });
  });

  it('ends the response instead of corrupting a partially sent one', () => {
    const { host, captured, end } = createHost({ headersSent: true });

    filter.catch(new Error('late failure'), host);

    expect(end).toHaveBeenCalledTimes(1);
    expect(captured.status).toBe(0);
  });

  it('logs 5xx with a stack and 4xx without', () => {
    const errorSpy = jest.spyOn(loggerOf(filter), 'error');
    const warnSpy = jest.spyOn(loggerOf(filter), 'warn');

    filter.catch(new Error('boom'), createHost().host);
    filter.catch(new NotFoundException(), createHost().host);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls[0]?.[0])).toContain('stack');
  });
});
