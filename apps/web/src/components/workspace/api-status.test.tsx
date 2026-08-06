import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiStatus } from './api-status';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-client', async (importOriginal) => {
  // Keep ApiClientError real so retry classification behaves as in production.
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: apiFetchMock };
});

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ApiStatus', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a checking state before the first response', () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined));

    renderWithQueryClient(<ApiStatus />);

    expect(screen.getByText(/checking api/i)).toBeInTheDocument();
  });

  it('reports the API as online with its version', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      service: 'wdrg-api',
      version: '0.1.0',
      uptimeSeconds: 12,
      timestamp: new Date().toISOString(),
    });

    renderWithQueryClient(<ApiStatus />);

    expect(await screen.findByText(/API online · v0\.1\.0/)).toBeInTheDocument();
  });

  it('degrades gracefully when the API cannot be reached', async () => {
    apiFetchMock.mockRejectedValue(new Error('network down'));

    renderWithQueryClient(<ApiStatus />);

    expect(await screen.findByText(/api unreachable/i)).toBeInTheDocument();
  });

  it('treats a non-ok liveness payload as unreachable', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'shutting_down',
      service: 'wdrg-api',
      version: '0.1.0',
      uptimeSeconds: 900,
      timestamp: new Date().toISOString(),
    });

    renderWithQueryClient(<ApiStatus />);

    await waitFor(() => {
      expect(screen.getByText(/api unreachable/i)).toBeInTheDocument();
    });
  });

  it('labels the status for screen readers', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      service: 'wdrg-api',
      version: '0.1.0',
      uptimeSeconds: 5,
      timestamp: new Date().toISOString(),
    });

    renderWithQueryClient(<ApiStatus />);

    expect(await screen.findByText('API status:')).toBeInTheDocument();
  });
});
