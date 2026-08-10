'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcknowledgeFeasibility,
  ApproveEstimate,
  CapacityLine,
  CreateDependency,
  ExistingSystem,
  ManualEstimate,
  OverrideEstimate,
  ReopenEstimate,
  StartEstimation,
  WorkingCalendar,
} from '@wdrg/contracts';
import { useCallback } from 'react';

import {
  acknowledgeTimelineRisk,
  addDependency,
  addManualEstimate,
  approveEstimate,
  overrideEstimate,
  readEstimate,
  readEstimateVersions,
  readEstimationRun,
  recalculateSchedule,
  removeDependency,
  reopenEstimate,
  resetEstimate,
  runEstimation,
  setCalendar,
  setExistingSystem,
  setTeam,
} from '@/lib/estimation-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Phase 6 data, and the mutations that change it.
 *
 * The same convention as Phase 5: **every mutation returns the whole estimate
 * and seeds the cache with it.** Changing one figure moves the totals, the
 * schedule, the utilisation, the feasibility and whether approval is possible —
 * a mutation returning only what it touched would leave the screen showing a
 * feasibility verdict that no longer applies.
 */

export function useEstimate() {
  return useQuery({
    queryKey: queryKeys.estimate,
    queryFn: readEstimate,
    /*
     * Always refetched on mount, overriding the application's 30-second
     * default — the same reason as the stack. This screen's answer depends on
     * things changed elsewhere: a document added, the stack unlocked, the
     * timeline moved. A cached "the deadline is achievable" is not slow, it is
     * wrong.
     */
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useEstimateVersions() {
  return useQuery({ queryKey: queryKeys.estimateVersions, queryFn: readEstimateVersions });
}

export function useEstimationRun() {
  return useQuery({ queryKey: queryKeys.estimationRun, queryFn: readEstimationRun });
}

function useSeedEstimate() {
  const queryClient = useQueryClient();

  return useCallback(
    (view: unknown) => {
      queryClient.setQueryData(queryKeys.estimate, view);
      void queryClient.invalidateQueries({ queryKey: queryKeys.estimateVersions });
    },
    [queryClient],
  );
}

export function useRunEstimation() {
  const seed = useSeedEstimate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: StartEstimation) => runEstimation(request),
    onSuccess: (view) => {
      seed(view);
      void queryClient.invalidateQueries({ queryKey: queryKeys.estimationRun });
    },
  });
}

export function useOverrideEstimate() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: ({ estimateId, request }: { estimateId: string; request: OverrideEstimate }) =>
      overrideEstimate(estimateId, request),
    onSuccess: seed,
  });
}

export function useResetEstimate() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: ({
      estimateId,
      expectedVersion,
    }: {
      estimateId: string;
      expectedVersion: number;
    }) => resetEstimate(estimateId, expectedVersion),
    onSuccess: seed,
  });
}

export function useAddManualEstimate() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: (request: ManualEstimate) => addManualEstimate(request),
    onSuccess: seed,
  });
}

export function useAddDependency() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: (request: CreateDependency) => addDependency(request),
    onSuccess: seed,
  });
}

export function useRemoveDependency() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: ({
      dependencyId,
      expectedVersion,
    }: {
      dependencyId: string;
      expectedVersion: number;
    }) => removeDependency(dependencyId, expectedVersion),
    onSuccess: seed,
  });
}

export function useSetCalendar() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: ({
      calendar,
      expectedVersion,
    }: {
      calendar: WorkingCalendar;
      expectedVersion: number;
    }) => setCalendar(calendar, expectedVersion),
    onSuccess: seed,
  });
}

export function useSetTeam() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: ({
      lines,
      expectedVersion,
    }: {
      lines: readonly CapacityLine[];
      expectedVersion: number;
    }) => setTeam(lines, expectedVersion),
    onSuccess: seed,
  });
}

export function useSetExistingSystem() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: ({
      existingSystem,
      expectedVersion,
    }: {
      existingSystem: ExistingSystem;
      expectedVersion: number;
    }) => setExistingSystem(existingSystem, expectedVersion),
    onSuccess: seed,
  });
}

export function useRecalculateSchedule() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: (expectedVersion: number) => recalculateSchedule(expectedVersion),
    onSuccess: seed,
  });
}

export function useAcknowledgeTimelineRisk() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: (request: AcknowledgeFeasibility) => acknowledgeTimelineRisk(request),
    onSuccess: seed,
  });
}

export function useApproveEstimate() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: (request: ApproveEstimate) => approveEstimate(request),
    onSuccess: seed,
  });
}

export function useReopenEstimate() {
  const seed = useSeedEstimate();

  return useMutation({
    mutationFn: (request: ReopenEstimate) => reopenEstimate(request),
    onSuccess: seed,
  });
}
