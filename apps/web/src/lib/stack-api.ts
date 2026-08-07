import {
  STACK_ROUTES,
  type AcknowledgeRisk,
  type ApproveStack,
  type CatalogEntry,
  type DecideRecommendation,
  type DownstreamAuthority,
  type LockStack,
  type RecommendationRun,
  type SelectTechnology,
  type StackSelectionMode,
  type StackSnapshot,
  type StartRecommendation,
  type UnlockStack,
} from '@wdrg/contracts';

import { apiFetch } from './api-client';
import { mutationHeaders } from './project-api';

/**
 * Typed calls for every Phase 5 endpoint.
 *
 * As in every phase before it, the CSRF header is attached here rather than at
 * each call site, so a new mutation cannot ship without one — these functions
 * are the only way the application reaches the API.
 */

export interface StackView {
  readonly snapshot: StackSnapshot;
  readonly catalogVersion: string;
}

export interface CatalogView {
  readonly catalogVersion: string;
  readonly entries: CatalogEntry[];
}

export interface RecommendationRunView {
  readonly run: RecommendationRun | null;
  /** Whether this deployment has inference configured at all. */
  readonly configured: boolean;
}

export async function readStack(): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.stack);
}

export async function readStackVersions(): Promise<{ versions: StackSnapshot[] }> {
  return apiFetch<{ versions: StackSnapshot[] }>(STACK_ROUTES.stackVersions);
}

export async function readCatalog(): Promise<CatalogView> {
  return apiFetch<CatalogView>(STACK_ROUTES.catalog);
}

export async function setSelectionMode(
  mode: StackSelectionMode,
  expectedVersion: number,
): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.mode, {
    method: 'PUT',
    body: { mode, expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function selectTechnology(request: SelectTechnology): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.components, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function decideRecommendation(
  componentId: string,
  request: DecideRecommendation,
): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.decideComponent(componentId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function lockComponent(
  componentId: string,
  expectedVersion: number,
): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.lockComponent(componentId), {
    method: 'POST',
    body: { expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function unlockComponent(
  componentId: string,
  expectedVersion: number,
): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.unlockComponent(componentId), {
    method: 'POST',
    body: { expectedVersion },
    headers: mutationHeaders(),
  });
}

export async function requestRecommendations(request: StartRecommendation): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.recommendations, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function readRecommendationRun(): Promise<RecommendationRunView> {
  return apiFetch<RecommendationRunView>(STACK_ROUTES.currentRecommendationRun);
}

export async function acknowledgeRisk(request: AcknowledgeRisk): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.acknowledgeRisk, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function approveStack(request: ApproveStack): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.approve, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function lockStack(request: LockStack): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.lock, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function unlockStack(request: UnlockStack): Promise<StackView> {
  return apiFetch<StackView>(STACK_ROUTES.unlock, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function readAuthority(): Promise<DownstreamAuthority> {
  return apiFetch<DownstreamAuthority>(STACK_ROUTES.authority);
}
