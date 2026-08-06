import { CORRELATION_ID_HEADER } from '@wdrg/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, type ApiClientError } from './api-client';

function jsonResponse(body: unknown, init: { status?: number; correlationId?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });

  if (init.correlationId) {
    headers.set(CORRELATION_ID_HEADER, init.correlationId);
  }

  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

const errorEnvelope = {
  error: {
    code: 'VALIDATION_FAILED',
    message: 'The submitted data is invalid.',
    status: 422,
    correlationId: 'corr-123',
    timestamp: '2026-08-03T10:00:00.000Z',
    path: '/api/v1/projects',
    details: [{ path: 'projectName', message: 'Project name is required.' }],
  },
};

describe('apiFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    await expect(apiFetch('/api/health/live')).resolves.toEqual({ status: 'ok' });
  });

  it('sends credentials so the project session cookie travels with the request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await apiFetch('/api/v1/projects');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('serialises a JSON body and sets the content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await apiFetch('/api/v1/projects', { method: 'POST', body: { projectName: 'Acme' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"projectName":"Acme"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('maps a contract error envelope onto ApiClientError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(errorEnvelope, { status: 422 }));

    await expect(apiFetch('/api/v1/projects')).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'VALIDATION_FAILED',
      status: 422,
      correlationId: 'corr-123',
    });
  });

  it('surfaces field details for form binding', async () => {
    fetchMock.mockResolvedValue(jsonResponse(errorEnvelope, { status: 422 }));

    const error = await apiFetch('/api/v1/projects').catch((caught: unknown) => caught);

    expect((error as ApiClientError).details?.[0]?.path).toBe('projectName');
  });

  it('does not render an unrecognised error body from an upstream proxy', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>502 Bad Gateway — upstream 10.0.0.4:3001</html>', { status: 502 }),
    );

    const error = (await apiFetch('/api/v1/projects').catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).not.toContain('10.0.0.4');
  });

  it('converts a transport failure into a retryable network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = (await apiFetch('/api/health/live').catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.isRetryable).toBe(true);
  });

  it('treats 204 as an empty body rather than a parse failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch('/api/v1/projects/abc')).resolves.toBeNull();
  });

  it('classifies client errors as non-retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(errorEnvelope, { status: 422 }));

    const error = (await apiFetch('/api/v1/projects').catch(
      (caught: unknown) => caught,
    )) as ApiClientError;

    expect(error.isRetryable).toBe(false);
  });
});
