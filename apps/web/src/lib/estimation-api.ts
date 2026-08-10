import {
  ESTIMATION_ROUTES,
  type AcknowledgeFeasibility,
  type ApproveEstimate,
  type CapacityLine,
  type CreateDependency,
  type EstimateSnapshot,
  type EstimationRun,
  type ExistingSystem,
  type ManualEstimate,
  type OverrideEstimate,
  type ReopenEstimate,
  type StartEstimation,
  type WorkingCalendar,
} from '@wdrg/contracts';

import { apiFetch } from './api-client';
import { mutationHeaders } from './project-api';

/**
 * Typed calls for every Phase 6 endpoint.
 *
 * As in every phase before it, the CSRF header is attached here rather than at
 * each call site, so a new mutation cannot ship without one.
 */

export interface EstimateView {
  readonly snapshot: EstimateSnapshot;
  readonly dependencyProblems: readonly {
    readonly kind: string;
    readonly ids: readonly string[];
    readonly summary: string;
    readonly blocking: boolean;
  }[];
  readonly applicableRoles: readonly string[];
}

export interface EstimationRunView {
  readonly run: EstimationRun | null;
  readonly configured: boolean;
}

export async function readEstimate(): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.estimate);
}

export async function readEstimateVersions(): Promise<{ versions: EstimateSnapshot[] }> {
  return apiFetch<{ versions: EstimateSnapshot[] }>(ESTIMATION_ROUTES.versions);
}

export async function readEstimationRun(): Promise<EstimationRunView> {
  return apiFetch<EstimationRunView>(ESTIMATION_ROUTES.currentRun);
}

export async function runEstimation(request: StartEstimation): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.run, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function addManualEstimate(request: ManualEstimate): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.estimates, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function overrideEstimate(
  estimateId: string,
  request: OverrideEstimate,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.estimateUnit(estimateId), {
    method: 'PATCH',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resetEstimate(
  estimateId: string,
  expectedVersion: number,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.resetEstimate(estimateId), {
    method: 'POST',
    body: { expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function addDependency(request: CreateDependency): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.dependencies, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function removeDependency(
  dependencyId: string,
  expectedVersion: number,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.dependency(dependencyId), {
    method: 'DELETE',
    body: { expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function setCalendar(
  calendar: WorkingCalendar,
  expectedVersion: number,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.calendar, {
    method: 'PUT',
    body: { calendar, expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function setTeam(
  lines: readonly CapacityLine[],
  expectedVersion: number,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.team, {
    method: 'PUT',
    body: { lines, expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function setExistingSystem(
  existingSystem: ExistingSystem,
  expectedVersion: number,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.existingSystem, {
    method: 'PUT',
    body: { existingSystem, expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function recalculateSchedule(expectedVersion: number): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.recalculateSchedule, {
    method: 'POST',
    body: { expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function acknowledgeTimelineRisk(
  request: AcknowledgeFeasibility,
): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.acknowledgeRisk, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function approveEstimate(request: ApproveEstimate): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.approve, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function reopenEstimate(request: ReopenEstimate): Promise<EstimateView> {
  return apiFetch<EstimateView>(ESTIMATION_ROUTES.reopen, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}
