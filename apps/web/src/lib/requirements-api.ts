import {
  REQUIREMENT_ROUTES,
  UPLOAD_FIELD_NAME,
  type AddTextSourceRequest,
  type CorrectContentRequest,
  type RequirementSource,
  type SourceListResponse,
  type UpdateTextSourceRequest,
  type UploadResponse,
} from '@wdrg/contracts';

import { apiFetch } from './api-client';
import { publicEnv } from './env';
import { mutationHeaders } from './project-api';

/**
 * Typed calls for every Phase 3 endpoint.
 *
 * As in Phase 2, the CSRF header is attached here rather than at each call site,
 * so a new mutation cannot ship without it — these functions are the only way
 * the application reaches the API.
 */

export async function listSources(): Promise<SourceListResponse> {
  return apiFetch<SourceListResponse>(REQUIREMENT_ROUTES.sources);
}

export async function addTextSource(request: AddTextSourceRequest): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.textSources, {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function updateTextSource(
  sourceId: string,
  request: UpdateTextSourceRequest,
): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.textSource(sourceId), {
    method: 'PUT',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function readSource(sourceId: string): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.source(sourceId));
}

export async function correctContent(
  sourceId: string,
  request: CorrectContentRequest,
): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.corrections(sourceId), {
    method: 'PUT',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function restoreOriginal(
  sourceId: string,
  version: number,
): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.restore(sourceId), {
    method: 'POST',
    body: { version },
    headers: mutationHeaders(),
  });
}

export async function markReviewed(sourceId: string, version: number): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.review(sourceId), {
    method: 'POST',
    body: { version },
    headers: mutationHeaders(),
  });
}

export async function retrySource(sourceId: string): Promise<RequirementSource> {
  return apiFetch<RequirementSource>(REQUIREMENT_ROUTES.retry(sourceId), {
    method: 'POST',
    headers: mutationHeaders(),
  });
}

export async function deleteSource(sourceId: string): Promise<void> {
  await apiFetch(REQUIREMENT_ROUTES.source(sourceId), {
    method: 'DELETE',
    headers: mutationHeaders(),
  });
}

/** The authorized download URL. A session is still required to fetch it. */
export function downloadUrl(sourceId: string): string {
  return REQUIREMENT_ROUTES.download(sourceId);
}

/**
 * Uploads files as multipart.
 *
 * Not routed through `apiFetch`: that helper sets `Content-Type: application/json`
 * and serialises the body, and a multipart request needs the browser to set the
 * header itself so it can include the boundary. Setting it by hand produces a
 * request no server can parse.
 */
export async function uploadFiles(
  files: readonly File[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<UploadResponse> {
  const body = new FormData();

  for (const file of files) {
    body.append(UPLOAD_FIELD_NAME, file, file.name);
  }

  const response = await fetch(
    `${publicEnv.NEXT_PUBLIC_API_BASE_URL}${REQUIREMENT_ROUTES.uploads}`,
    {
      method: 'POST',
      body,
      credentials: 'include',
      headers: mutationHeaders(),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;

    throw new Error(
      problem?.error?.message ?? 'The files could not be uploaded. Please try again.',
    );
  }

  return (await response.json()) as UploadResponse;
}
