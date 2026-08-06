'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiClientError } from '@/lib/api-client';

/**
 * Retrying a request the user cannot fix by waiting (a validation failure, a
 * missing project) just delays the error message. Only genuinely transient
 * failures are retried.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError && !error.isRetryable) {
    return false;
  }

  return failureCount < 2;
}

export function AppProviders({ children }: { children: ReactNode }) {
  // Created in state so each browser session gets exactly one client, and so a
  // server render never shares a cache between users.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: shouldRetry,
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
