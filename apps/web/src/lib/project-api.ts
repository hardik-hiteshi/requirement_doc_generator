import {
  CSRF_COOKIE,
  CSRF_HEADER,
  PROJECT_ROUTES,
  type CreateProjectRequest,
  type DeleteProjectResponse,
  type OutputPreferences,
  type ProjectCreatedResponse,
  type ProjectDetails,
  type ProjectResponse,
  type ProjectSessionResponse,
  type StartDate,
  type TeamCapacity,
  type Timeline,
} from '@wdrg/contracts';

import { apiFetch } from './api-client';

/**
 * Typed calls for every Phase 2 endpoint.
 *
 * Each mutation attaches the CSRF header read from the readable CSRF cookie.
 * Doing it here rather than at each call site means a new mutation cannot ship
 * without it — the only way to reach the API is through these functions.
 */

/** Reads the double-submit CSRF token the API set. */
export function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }

  const match = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));

  const value = match?.slice(CSRF_COOKIE.length + 1);

  // An empty cookie is as good as absent, but `??` would keep it.
  return value && value.length > 0 ? value : undefined;
}

/** Exported so the multipart upload path can attach the same header. */
export function mutationHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { [CSRF_HEADER]: token } : {};
}

export async function createProject(
  request: CreateProjectRequest,
): Promise<ProjectCreatedResponse> {
  return apiFetch<ProjectCreatedResponse>(PROJECT_ROUTES.create, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function exchangeRecoverySecret(
  projectId: string,
  recoverySecret: string,
): Promise<ProjectSessionResponse> {
  return apiFetch<ProjectSessionResponse>(PROJECT_ROUTES.exchange, {
    method: 'POST',
    body: { projectId, recoverySecret },
    headers: mutationHeaders(),
  });
}

export async function fetchCurrentProject(): Promise<ProjectResponse> {
  return apiFetch<ProjectResponse>(PROJECT_ROUTES.current);
}

export async function endProjectSession(): Promise<void> {
  await apiFetch(PROJECT_ROUTES.endSession, {
    method: 'DELETE',
    headers: mutationHeaders(),
  });
}

/** Every section update sends the version the client last saw. */
interface VersionedUpdate {
  readonly version: number;
}

export async function updateDetails(
  payload: VersionedUpdate & { details: ProjectDetails },
): Promise<ProjectResponse> {
  return apiFetch<ProjectResponse>(PROJECT_ROUTES.details, {
    method: 'PUT',
    body: payload,
    headers: mutationHeaders(),
  });
}

export async function updateTimeline(
  payload: VersionedUpdate & { timeline: Timeline },
): Promise<ProjectResponse> {
  return apiFetch<ProjectResponse>(PROJECT_ROUTES.timeline, {
    method: 'PUT',
    body: payload,
    headers: mutationHeaders(),
  });
}

export async function updateStartDate(
  payload: VersionedUpdate & { startDate: StartDate },
): Promise<ProjectResponse> {
  return apiFetch<ProjectResponse>(PROJECT_ROUTES.startDate, {
    method: 'PUT',
    body: payload,
    headers: mutationHeaders(),
  });
}

export async function updateTeamCapacity(
  payload: VersionedUpdate & { teamCapacity: TeamCapacity },
): Promise<ProjectResponse> {
  return apiFetch<ProjectResponse>(PROJECT_ROUTES.teamCapacity, {
    method: 'PUT',
    body: payload,
    headers: mutationHeaders(),
  });
}

export async function updateOutputPreferences(
  payload: VersionedUpdate & { outputPreferences: OutputPreferences },
): Promise<ProjectResponse> {
  return apiFetch<ProjectResponse>(PROJECT_ROUTES.outputPreferences, {
    method: 'PUT',
    body: payload,
    headers: mutationHeaders(),
  });
}

export async function deleteProject(
  payload: VersionedUpdate & { confirmationName: string },
): Promise<DeleteProjectResponse> {
  return apiFetch<DeleteProjectResponse>(PROJECT_ROUTES.delete, {
    method: 'DELETE',
    body: payload,
    headers: mutationHeaders(),
  });
}
