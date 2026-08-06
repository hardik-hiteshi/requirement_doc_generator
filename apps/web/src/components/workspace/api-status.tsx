'use client';

import { useQuery } from '@tanstack/react-query';
import { HEALTH_ROUTES, type LivenessResponse } from '@wdrg/contracts';
import { Badge } from '@wdrg/ui';

import { apiFetch } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/**
 * Live API reachability indicator.
 *
 * Present from Phase 1 because it exercises the whole client path end to end —
 * shared contract, typed fetch wrapper, query client, error normalisation — and
 * because "is the backend up?" is the first question during local setup.
 */
export function ApiStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiFetch<LivenessResponse>(HEALTH_ROUTES.liveness),
    refetchInterval: 60_000,
  });

  if (isPending) {
    return (
      <Badge tone="neutral">
        <span className="sr-only">API status: </span>Checking API…
      </Badge>
    );
  }

  if (isError || data?.status !== 'ok') {
    return (
      <Badge tone="danger">
        <span className="sr-only">API status: </span>API unreachable
      </Badge>
    );
  }

  return (
    <Badge tone="success">
      <span className="sr-only">API status: </span>
      {`API online · v${data.version}`}
    </Badge>
  );
}
