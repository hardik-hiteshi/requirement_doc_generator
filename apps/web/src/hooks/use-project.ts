'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectResponse } from '@wdrg/contracts';
import { useCallback, useState } from 'react';

import { ApiClientError } from '@/lib/api-client';
import { fetchCurrentProject } from '@/lib/project-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * How a section's save is presented to the user.
 *
 * `conflict` is distinct from `error` because it needs a different response:
 * the user's input is fine, the project simply moved on, and the fix is to
 * reload rather than retry.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

export function useCurrentProject() {
  return useQuery({
    queryKey: queryKeys.currentProject,
    queryFn: fetchCurrentProject,
    // A 401 means there is no session — that is an answer, not a failure to
    // retry. Anything else is handled by the client's default retry policy.
    retry: (failureCount, error) =>
      !(error instanceof ApiClientError && error.status === 401) && failureCount < 1,
    staleTime: 10_000,
  });
}

function isVersionConflict(error: ApiClientError): boolean {
  return Boolean(error.details?.some((detail) => detail.rule === 'version_conflict'));
}

interface SectionMutationOptions<TInput> {
  readonly mutate: (input: TInput & { version: number }) => Promise<ProjectResponse>;
}

/**
 * Wraps a section update with the shared save-state handling.
 *
 * The version is read from the cached project rather than passed in, so a caller
 * cannot accidentally submit a stale one it captured earlier. On success the
 * cache is replaced with the server's response, which carries the new version —
 * making the next save use it automatically.
 */
export function useSectionSave<TInput>({ mutate }: SectionMutationOptions<TInput>) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>('idle');
  const [message, setMessage] = useState<string | undefined>();

  const mutation = useMutation({
    mutationFn: async (input: TInput) => {
      const current = queryClient.getQueryData<ProjectResponse>(queryKeys.currentProject);

      if (!current) {
        throw new ApiClientError('NOT_FOUND', 'The project is not loaded yet.', 0);
      }

      return mutate({ ...input, version: current.version });
    },
    onMutate: () => {
      setState('saving');
      setMessage(undefined);
    },
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.currentProject, project);
      setState('saved');
      setMessage(undefined);
    },
    onError: (error: unknown) => {
      // A version conflict and an unmodifiable project share a status code but
      // are different situations, and only one of them is fixed by reloading.
      // The API distinguishes them by attaching a `version` detail, so branch on
      // that rather than telling a user whose project has expired that somebody
      // else edited it.
      if (
        error instanceof ApiClientError &&
        error.code === 'CONFLICT' &&
        isVersionConflict(error)
      ) {
        setState('conflict');
        setMessage(error.message);
        return;
      }

      setState('error');
      setMessage(
        error instanceof ApiClientError ? error.message : 'Could not save. Please try again.',
      );
    },
  });

  const reset = useCallback(() => {
    setState('idle');
    setMessage(undefined);
  }, []);

  return {
    save: mutation.mutate,
    saveAsync: mutation.mutateAsync,
    state,
    message,
    reset,
    /** Field-level problems, for binding back onto the form. */
    fieldErrors: mutation.error instanceof ApiClientError ? mutation.error.details : undefined,
  };
}
