import {
  ANALYSIS_ROUTES,
  type AmbiguityFinding,
  type AnalysisRun,
  type AnswerClarification,
  type ApproveBaseline,
  type Baseline,
  type Clarification,
  type Conflict,
  type DuplicateGroup,
  type ManualRequirement,
  type MissingInfoFinding,
  type RequirementItem,
  type RequirementItemEdit,
  type ResolveConflict,
  type ResolveDuplicate,
  type ResolveFinding,
  type StartAnalysis,
} from '@wdrg/contracts';

import { apiFetch } from './api-client';
import { mutationHeaders } from './project-api';

/**
 * Typed calls for every Phase 4 endpoint.
 *
 * As in Phases 2 and 3, the CSRF header is attached here rather than at each
 * call site, so a new mutation cannot ship without it — these functions are the
 * only way the application reaches the API.
 */

export interface FindingsResponse {
  readonly duplicates: DuplicateGroup[];
  readonly conflicts: Conflict[];
  readonly ambiguities: AmbiguityFinding[];
  readonly gaps: MissingInfoFinding[];
}

export interface BaselineView {
  readonly baseline: Baseline;
  readonly notice: string;
}

export async function startAnalysis(request: StartAnalysis): Promise<AnalysisRun> {
  return apiFetch<AnalysisRun>(ANALYSIS_ROUTES.runs, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function readCurrentRun(): Promise<AnalysisRun | null> {
  return apiFetch<AnalysisRun | null>(ANALYSIS_ROUTES.currentRun);
}

export async function cancelRun(runId: string): Promise<AnalysisRun> {
  return apiFetch<AnalysisRun>(ANALYSIS_ROUTES.cancelRun(runId), {
    method: 'POST',
    headers: mutationHeaders(),
  });
}

export async function listRequirements(): Promise<RequirementItem[]> {
  return apiFetch<RequirementItem[]>(ANALYSIS_ROUTES.requirements);
}

export async function editRequirement(
  itemId: string,
  edit: RequirementItemEdit,
): Promise<RequirementItem> {
  return apiFetch<RequirementItem>(ANALYSIS_ROUTES.requirement(itemId), {
    method: 'PATCH',
    body: edit,
    headers: mutationHeaders(),
  });
}

export async function addRequirement(request: ManualRequirement): Promise<RequirementItem> {
  return apiFetch<RequirementItem>(ANALYSIS_ROUTES.requirements, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function listFindings(): Promise<FindingsResponse> {
  return apiFetch<FindingsResponse>(ANALYSIS_ROUTES.findings);
}

export async function resolveDuplicate(groupId: string, request: ResolveDuplicate): Promise<void> {
  await apiFetch<void>(ANALYSIS_ROUTES.duplicate(groupId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resolveConflict(conflictId: string, request: ResolveConflict): Promise<void> {
  await apiFetch<void>(ANALYSIS_ROUTES.conflict(conflictId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resolveAmbiguity(findingId: string, request: ResolveFinding): Promise<void> {
  await apiFetch<void>(ANALYSIS_ROUTES.ambiguity(findingId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resolveGap(findingId: string, request: ResolveFinding): Promise<void> {
  await apiFetch<void>(ANALYSIS_ROUTES.gap(findingId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function listClarifications(): Promise<Clarification[]> {
  return apiFetch<Clarification[]>(ANALYSIS_ROUTES.clarifications);
}

export async function answerClarification(
  clarificationId: string,
  request: AnswerClarification,
): Promise<Clarification> {
  return apiFetch<Clarification>(ANALYSIS_ROUTES.answerClarification(clarificationId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function dismissClarification(
  clarificationId: string,
  reason: string,
  expectedVersion: number,
): Promise<Clarification> {
  return apiFetch<Clarification>(ANALYSIS_ROUTES.dismissClarification(clarificationId), {
    method: 'POST',
    body: { reason, expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function readBaseline(): Promise<BaselineView> {
  return apiFetch<BaselineView>(ANALYSIS_ROUTES.baseline);
}

export async function listBaselineVersions(): Promise<Baseline[]> {
  return apiFetch<Baseline[]>(ANALYSIS_ROUTES.baselineVersions);
}

export async function startBaselineReview(): Promise<Baseline> {
  return apiFetch<Baseline>(ANALYSIS_ROUTES.reviewBaseline, {
    method: 'POST',
    headers: mutationHeaders(),
  });
}

export async function approveBaseline(request: ApproveBaseline): Promise<Baseline> {
  return apiFetch<Baseline>(ANALYSIS_ROUTES.approveBaseline, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}
