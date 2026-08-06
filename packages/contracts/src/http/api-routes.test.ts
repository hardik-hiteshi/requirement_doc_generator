import { describe, expect, it } from 'vitest';

import { API_PREFIX, API_VERSION, HEALTH_ROUTES, buildApiPath } from './api-routes';
import { CORRELATION_ID_MAX_LENGTH, normalizeCorrelationId } from './headers';

describe('buildApiPath', () => {
  it('builds a versioned root path when no segments are given', () => {
    expect(buildApiPath()).toBe(`/${API_PREFIX}/v${API_VERSION}`);
  });

  it('joins segments', () => {
    expect(buildApiPath('projects', 'abc123', 'documents')).toBe(
      '/api/v1/projects/abc123/documents',
    );
  });

  it('normalises embedded slashes and blank segments', () => {
    expect(buildApiPath('/projects/', '', ' abc123 ')).toBe('/api/v1/projects/abc123');
  });
});

describe('health routes', () => {
  it('are version-neutral so probes survive an API version bump', () => {
    expect(HEALTH_ROUTES.liveness).toBe('/api/health/live');
    expect(HEALTH_ROUTES.readiness).toBe('/api/health/ready');
    expect(HEALTH_ROUTES.liveness).not.toContain('/v1/');
  });
});

describe('normalizeCorrelationId', () => {
  it('accepts a well-formed id', () => {
    expect(normalizeCorrelationId('req-01HZX9.ab:12')).toBe('req-01HZX9.ab:12');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCorrelationId('  abc123  ')).toBe('abc123');
  });

  it.each([
    ['a newline injection attempt', 'abc\nINFO fake log line'],
    ['a carriage return', 'abc\r\n'],
    ['an over-long value', 'a'.repeat(CORRELATION_ID_MAX_LENGTH + 1)],
    ['an empty string', ''],
    ['a space-separated value', 'abc def'],
  ])('rejects %s', (_label, value) => {
    expect(normalizeCorrelationId(value)).toBeNull();
  });

  it.each([null, undefined, 42, {}, []])('rejects non-string %p', (value) => {
    expect(normalizeCorrelationId(value)).toBeNull();
  });
});
