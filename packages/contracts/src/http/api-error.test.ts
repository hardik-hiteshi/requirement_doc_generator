import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  DEFAULT_ERROR_MESSAGES,
  apiErrorResponseSchema,
  isApiErrorResponse,
} from './api-error';

const validError = {
  error: {
    code: API_ERROR_CODES.VALIDATION_FAILED,
    message: 'The submitted data is invalid.',
    status: 422,
    correlationId: 'a1b2c3d4',
    timestamp: '2026-08-03T10:00:00.000Z',
    path: '/api/v1/projects',
    details: [{ path: 'projectName', message: 'Project name is required.', rule: 'required' }],
  },
};

describe('apiErrorResponseSchema', () => {
  it('accepts a fully populated error envelope', () => {
    expect(apiErrorResponseSchema.parse(validError)).toEqual(validError);
  });

  it('accepts an envelope without field details', () => {
    const { details: _details, ...rest } = validError.error;
    expect(apiErrorResponseSchema.safeParse({ error: rest }).success).toBe(true);
  });

  it('rejects an unknown error code', () => {
    const result = apiErrorResponseSchema.safeParse({
      error: { ...validError.error, code: 'TEAPOT' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an envelope missing the correlation id', () => {
    const { correlationId: _correlationId, ...rest } = validError.error;
    expect(apiErrorResponseSchema.safeParse({ error: rest }).success).toBe(false);
  });
});

describe('isApiErrorResponse', () => {
  it('narrows a valid envelope', () => {
    expect(isApiErrorResponse(validError)).toBe(true);
  });

  it.each([null, undefined, 'error', 42, {}, { error: {} }])('rejects %p', (value) => {
    expect(isApiErrorResponse(value)).toBe(false);
  });
});

describe('error code tables', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of Object.values(API_ERROR_CODES)) {
      expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('maps every code to a default message', () => {
    for (const code of Object.values(API_ERROR_CODES)) {
      expect(DEFAULT_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('keeps the internal error message free of internal detail', () => {
    expect(DEFAULT_ERROR_MESSAGES[API_ERROR_CODES.INTERNAL_ERROR]).not.toMatch(
      /stack|exception|mongo|sql/i,
    );
  });
});
