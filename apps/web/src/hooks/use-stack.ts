'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcknowledgeRisk,
  ApproveStack,
  DecideRecommendation,
  LockStack,
  SelectTechnology,
  StackSelectionMode,
  StartRecommendation,
  UnlockStack,
} from '@wdrg/contracts';
import { useCallback } from 'react';

import {
  acknowledgeRisk,
  approveStack,
  decideRecommendation,
  lockComponent,
  lockStack,
  readCatalog,
  readRecommendationRun,
  readStack,
  readStackVersions,
  requestRecommendations,
  selectTechnology,
  setSelectionMode,
  unlockComponent,
  unlockStack,
} from '@/lib/stack-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Phase 5 data, and the mutations that change it.
 *
 * One convention, and it does most of the work: **every mutation returns the
 * whole stack and seeds the cache with it.** Choosing a technology recomputes
 * the compatibility findings, the risk level, the blockers and whether approval
 * is possible — so a mutation that returned only the thing it changed would
 * leave the screen showing an approval button that no longer means what it
 * says. The server is the only thing that knows all of it, and it sends all of
 * it back.
 */

export function useStack() {
  return useQuery({
    queryKey: queryKeys.stack,
    queryFn: readStack,
    /*
     * Always refetched when the screen opens, overriding the application's
     * 30-second default.
     *
     * This screen's whole job is to say whether the stack is still valid, and
     * the answer depends on things that change elsewhere — a document added, a
     * clarification confirmed, a baseline gone out of date. Serving a cached
     * "everything is fine" for half a minute after any of those is the one
     * failure mode that matters here: it is not slow, it is wrong.
     */
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useStackVersions() {
  return useQuery({ queryKey: queryKeys.stackVersions, queryFn: readStackVersions });
}

export function useTechnologyCatalog() {
  return useQuery({
    queryKey: queryKeys.stackCatalog,
    queryFn: readCatalog,
    // The catalogue is reviewed data that changes when the application ships,
    // not while a user is working. Refetching it on every focus is noise.
    staleTime: 10 * 60 * 1000,
  });
}

export function useRecommendationRun() {
  return useQuery({
    queryKey: queryKeys.stackRecommendationRun,
    queryFn: readRecommendationRun,
  });
}

/**
 * Replace the cached stack with what the server just returned.
 *
 * Seeding rather than invalidating, so the screen updates in one step instead
 * of blanking and refilling — and so a decision the user just made never
 * appears to revert for the duration of a refetch.
 */
function useSeedStack() {
  const queryClient = useQueryClient();

  return useCallback(
    (view: unknown) => {
      queryClient.setQueryData(queryKeys.stack, view);
      void queryClient.invalidateQueries({ queryKey: queryKeys.stackVersions });
    },
    [queryClient],
  );
}

export function useSetSelectionMode() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: ({
      mode,
      expectedVersion,
    }: {
      mode: StackSelectionMode;
      expectedVersion: number;
    }) => setSelectionMode(mode, expectedVersion),
    onSuccess: seed,
  });
}

export function useSelectTechnology() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: (request: SelectTechnology) => selectTechnology(request),
    onSuccess: seed,
  });
}

export function useDecideRecommendation() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: ({
      componentId,
      request,
    }: {
      componentId: string;
      request: DecideRecommendation;
    }) => decideRecommendation(componentId, request),
    onSuccess: seed,
  });
}

export function useLockComponent() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: ({
      componentId,
      expectedVersion,
      locked,
    }: {
      componentId: string;
      expectedVersion: number;
      /** True to lock, false to unlock. Two routes, one hook. */
      locked: boolean;
    }) =>
      locked
        ? lockComponent(componentId, expectedVersion)
        : unlockComponent(componentId, expectedVersion),
    onSuccess: seed,
  });
}

export function useRequestRecommendations() {
  const seed = useSeedStack();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: StartRecommendation) => requestRecommendations(request),
    onSuccess: (view) => {
      seed(view);
      void queryClient.invalidateQueries({ queryKey: queryKeys.stackRecommendationRun });
    },
  });
}

export function useAcknowledgeRisk() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: (request: AcknowledgeRisk) => acknowledgeRisk(request),
    onSuccess: seed,
  });
}

export function useApproveStack() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: (request: ApproveStack) => approveStack(request),
    onSuccess: seed,
  });
}

export function useLockStack() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: (request: LockStack) => lockStack(request),
    onSuccess: seed,
  });
}

export function useUnlockStack() {
  const seed = useSeedStack();

  return useMutation({
    mutationFn: (request: UnlockStack) => unlockStack(request),
    onSuccess: seed,
  });
}
