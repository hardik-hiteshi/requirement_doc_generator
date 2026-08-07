'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isRunFinished, type AnalysisRun } from '@wdrg/contracts';
import { useCallback, useEffect, useRef } from 'react';

import {
  answerClarification,
  approveBaseline,
  cancelRun,
  confirmClarification,
  listProposals,
  readConflictHistory,
  readRequirementHistory,
  resolveProposal,
  dismissClarification,
  editRequirement,
  listClarifications,
  listFindings,
  listRequirements,
  readBaseline,
  readCurrentRun,
  resolveAmbiguity,
  resolveConflict,
  resolveDuplicate,
  resolveGap,
  startAnalysis,
  startBaselineReview,
  addRequirement,
} from '@/lib/analysis-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Phase 4 data, and the mutations that change it.
 *
 * Two conventions run through the file.
 *
 * **Polling stops when the work does.** A local model on CPU takes minutes, so
 * the run has to be polled — but a finished project must not keep sending
 * requests forever, so the interval is a function of the run's own status.
 *
 * **Every mutation invalidates the baseline.** Almost everything in this phase
 * feeds the coverage, alignment and blocker numbers: resolving a conflict
 * changes an evidence score, which changes alignment, which changes whether
 * approval is possible. Refetching them after each change is what keeps the
 * *Approve* button honest about what it is offering.
 */

const POLL_INTERVAL_MS = 2_000;

export function useAnalysisRun() {
  const invalidate = useInvalidateAnalysis();
  /** The finished run whose results have already been fetched. */
  const settled = useRef<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.analysisRun,
    queryFn: readCurrentRun,
    refetchInterval: (current) => {
      const run: AnalysisRun | null | undefined = current.state.data;

      return run && !isRunFinished(run.status) ? POLL_INTERVAL_MS : false;
    },
  });

  const run = query.data;
  const finishedId = run && isRunFinished(run.status) ? `${run.id}:${run.status}` : null;

  /*
   * Refetch everything once per finished run.
   *
   * Starting a run invalidates the caches, but that happens when the request is
   * *accepted* — before there is anything to show. Without this the screen sits
   * on the empty list it fetched at the start and reports "Complete" above
   * nothing, which reads as a failure rather than as a stale cache.
   *
   * Keyed on the finished run rather than on a working → finished transition,
   * because a fast provider can finish before the first poll and there is then
   * no transition to observe. Both bugs were found by the browser suite.
   */
  useEffect(() => {
    if (finishedId !== null && settled.current !== finishedId) {
      settled.current = finishedId;
      void invalidate();
    }
  }, [finishedId, invalidate]);

  return query;
}

export function useRequirements() {
  return useQuery({ queryKey: queryKeys.requirements, queryFn: listRequirements });
}

export function useFindings() {
  return useQuery({ queryKey: queryKeys.findings, queryFn: listFindings });
}

export function useClarifications() {
  return useQuery({ queryKey: queryKeys.clarifications, queryFn: listClarifications });
}

export function useProposals() {
  return useQuery({ queryKey: queryKeys.proposals, queryFn: listProposals });
}

export function useRequirementHistory(itemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.requirementHistory(itemId ?? ''),
    queryFn: () => readRequirementHistory(itemId!),
    enabled: Boolean(itemId),
  });
}

export function useConflictHistory(conflictId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.conflictHistory(conflictId ?? ''),
    queryFn: () => readConflictHistory(conflictId!),
    enabled: Boolean(conflictId),
  });
}

export function useBaseline() {
  return useQuery({
    queryKey: queryKeys.baseline,
    queryFn: readBaseline,
    // A project with no baseline yet is the normal early state, not an error.
    retry: false,
  });
}

/** Everything Phase 4 shows, refetched after any change. */
function useInvalidateAnalysis() {
  const client = useQueryClient();

  // Stable, because `useAnalysisRun` puts it in an effect dependency list.
  return useCallback(async (): Promise<void> => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.requirements }),
      client.invalidateQueries({ queryKey: queryKeys.findings }),
      client.invalidateQueries({ queryKey: queryKeys.clarifications }),
      client.invalidateQueries({ queryKey: queryKeys.baseline }),
      client.invalidateQueries({ queryKey: queryKeys.proposals }),
    ]);
  }, [client]);
}

export function useStartAnalysis() {
  const client = useQueryClient();
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: startAnalysis,
    onSuccess: async (run) => {
      client.setQueryData(queryKeys.analysisRun, run);
      await invalidate();
    },
  });
}

export function useCancelAnalysis() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: cancelRun,
    onSuccess: (run) => client.setQueryData(queryKeys.analysisRun, run),
  });
}

export function useEditRequirement() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: ({ itemId, ...edit }: { itemId: string } & Parameters<typeof editRequirement>[1]) =>
      editRequirement(itemId, edit),
    onSuccess: invalidate,
  });
}

export function useAddRequirement() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({ mutationFn: addRequirement, onSuccess: invalidate });
}

export function useResolveDuplicate() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: ({
      groupId,
      ...request
    }: { groupId: string } & Parameters<typeof resolveDuplicate>[1]) =>
      resolveDuplicate(groupId, request),
    onSuccess: invalidate,
  });
}

export function useResolveConflict() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: ({
      conflictId,
      ...request
    }: { conflictId: string } & Parameters<typeof resolveConflict>[1]) =>
      resolveConflict(conflictId, request),
    onSuccess: invalidate,
  });
}

export function useResolveFinding(kind: 'ambiguity' | 'gap') {
  const invalidate = useInvalidateAnalysis();
  const call = kind === 'ambiguity' ? resolveAmbiguity : resolveGap;

  return useMutation({
    mutationFn: ({
      findingId,
      ...request
    }: { findingId: string } & Parameters<typeof resolveAmbiguity>[1]) => call(findingId, request),
    onSuccess: invalidate,
  });
}

export function useAnswerClarification() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: ({
      clarificationId,
      ...request
    }: { clarificationId: string } & Parameters<typeof answerClarification>[1]) =>
      answerClarification(clarificationId, request),
    onSuccess: invalidate,
  });
}

export function useConfirmClarification() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: (input: { clarificationId: string; expectedVersion: number }) =>
      confirmClarification(input.clarificationId, input.expectedVersion),
    onSuccess: invalidate,
  });
}

export function useResolveProposal() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: ({ itemId, ...request }: { itemId: string } & ResolveProposalInput) =>
      resolveProposal(itemId, request),
    onSuccess: invalidate,
  });
}

type ResolveProposalInput = Parameters<typeof resolveProposal>[1];

export function useDismissClarification() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({
    mutationFn: ({
      clarificationId,
      ...request
    }: { clarificationId: string } & Parameters<typeof dismissClarification>[1]) =>
      dismissClarification(clarificationId, request),
    onSuccess: invalidate,
  });
}

export function useStartBaselineReview() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({ mutationFn: startBaselineReview, onSuccess: invalidate });
}

export function useApproveBaseline() {
  const invalidate = useInvalidateAnalysis();

  return useMutation({ mutationFn: approveBaseline, onSuccess: invalidate });
}
