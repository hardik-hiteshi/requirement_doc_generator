import {
  ADMIN_ROUTES,
  ADMIN_TOKEN_HEADER,
  type AdminAuditResponse,
  type AdminConfig,
  type AdminProjectDetail,
  type AdminProjectList,
  type AdminQueueState,
  type AdminStatus,
} from '@wdrg/contracts';

import { publicEnv } from './env';

/**
 * The operator surface, from the browser.
 *
 * Separate from `api-client.ts` for one reason: the token. Every other request in this
 * application authenticates with a session cookie the browser holds; these carry a
 * deployment secret the operator typed, and it is passed in explicitly on every call
 * rather than stored anywhere this module could reach for it.
 *
 * ## The token is never persisted
 *
 * It is held in React state for the life of the tab and passed down. Not
 * `localStorage`, which survives the tab and is readable by any script that ever runs
 * on the origin; not a cookie, which would be sent automatically to requests that do
 * not need it. Closing the tab ends the operator's session, which for a shared machine
 * is the behaviour you want.
 *
 * A deployment that needs stronger handling should put the surface behind an
 * authenticating proxy — as `docs/operations/operator-surface.md` says.
 */

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function adminFetch<TResponse>(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${publicEnv.NEXT_PUBLIC_API_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), [ADMIN_TOKEN_HEADER]: token },
  });

  if (!response.ok) {
    /*
     * The API answers absent, malformed and wrong tokens identically, and a disabled
     * surface with a 404. The message shown is the server's where there is one, so an
     * operator is not left guessing between "wrong token" and "not enabled".
     */
    let message = `The operator surface answered ${response.status}.`;

    try {
      const body = (await response.json()) as { error?: { message?: string } };

      message = body.error?.message ?? message;
    } catch {
      /* Not JSON. The status alone is what there is to report. */
    }

    throw new AdminApiError(response.status, message);
  }

  return (await response.json()) as TResponse;
}

export const readAdminStatus = (token: string) =>
  adminFetch<AdminStatus>(ADMIN_ROUTES.status, token);

export const readAdminQueue = (token: string) =>
  adminFetch<AdminQueueState>(ADMIN_ROUTES.queue, token);

export const readAdminConfig = (token: string) =>
  adminFetch<AdminConfig>(ADMIN_ROUTES.config, token);

export const readAdminAudit = (token: string, limit = 25) =>
  adminFetch<AdminAuditResponse>(`${ADMIN_ROUTES.audit}?limit=${limit}`, token);

export const readAdminProjects = (token: string, projectId?: string) =>
  adminFetch<AdminProjectList>(
    projectId
      ? `${ADMIN_ROUTES.projects}?projectId=${encodeURIComponent(projectId)}`
      : ADMIN_ROUTES.projects,
    token,
  );

export const readAdminProject = (token: string, projectId: string) =>
  adminFetch<AdminProjectDetail>(ADMIN_ROUTES.project(projectId), token);

export const runRetentionSweep = (token: string) =>
  adminFetch<{ sweep?: unknown }>(ADMIN_ROUTES.retentionRun, token, { method: 'POST' });

export const retryExtractionJob = (token: string, jobId: string) =>
  adminFetch<{ job: { jobId: string; status: string } }>(ADMIN_ROUTES.jobRetry(jobId), token, {
    method: 'POST',
  });
