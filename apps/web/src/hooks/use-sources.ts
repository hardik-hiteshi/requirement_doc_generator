'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isSourceInProgress, type SourceListResponse } from '@wdrg/contracts';

import { listSources, readSource } from '@/lib/requirements-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * The project's requirement sources.
 *
 * Polls only while something is actually being worked on. A fixed interval
 * would keep a finished project sending requests forever; stopping when every
 * source has settled means the common case — reviewing content — makes no
 * background traffic at all.
 */
export function useSources() {
  return useQuery({
    queryKey: queryKeys.sources,
    queryFn: listSources,
    refetchInterval: (query) => {
      const data: SourceListResponse | undefined = query.state.data;

      if (!data) {
        return false;
      }

      return data.sources.some((source) => isSourceInProgress(source.status)) ? 1_500 : false;
    },
  });
}

/** One source with its content. Enabled only once a source is selected. */
export function useSource(sourceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.source(sourceId ?? ''),
    queryFn: () => readSource(sourceId!),
    enabled: Boolean(sourceId),
  });
}

/**
 * Refreshes both the list and the open source after a change.
 *
 * A correction changes the source *and* its row in the list — the block count,
 * the review badge. Invalidating one and not the other is how a UI ends up
 * showing a stale summary beside fresh content.
 */
export function useRefreshSources() {
  const queryClient = useQueryClient();

  return (sourceId?: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sources });

    if (sourceId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.source(sourceId) });
    }
  };
}

/** Wraps a source mutation with the shared refresh and error handling. */
export function useSourceMutation<TVariables, TResult>(
  mutate: (variables: TVariables) => Promise<TResult>,
  options: { readonly sourceId?: string } = {},
) {
  const refresh = useRefreshSources();

  return useMutation({
    mutationFn: mutate,
    onSuccess: () => refresh(options.sourceId),
  });
}
