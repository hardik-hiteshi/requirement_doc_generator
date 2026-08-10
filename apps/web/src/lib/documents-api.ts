import {
  DOCUMENT_ROUTES,
  type AcknowledgeFinding,
  type ApproveDocument,
  type DocumentDiff,
  type DocumentRun,
  type DocumentSnapshot,
  type DocumentSummary,
  type DocumentType,
  type DocumentVersionSummary,
  type FeatureRow,
  type GenerateDocument,
  type MarkFinal,
  type RegenerateSection,
  type ReopenDocument,
  type ResolveSectionProposal,
  type RestoreVersion,
  type UpdateFeatureRow,
  type UpdateSection,
} from '@wdrg/contracts';

import { apiFetch } from './api-client';
import { mutationHeaders } from './project-api';

/**
 * Typed calls for every Phase 7 endpoint.
 *
 * As in every phase before it, the CSRF header is attached here rather than at
 * each call site, so a new mutation cannot ship without one.
 *
 * One set of functions for all document types, with the type as an argument —
 * the API is shared, so the client is too.
 */

export interface DocumentView {
  readonly document: DocumentSnapshot;
}

export async function readDocuments(): Promise<{ documents: DocumentSummary[] }> {
  return apiFetch<{ documents: DocumentSummary[] }>(DOCUMENT_ROUTES.documents);
}

export async function readDocument(type: DocumentType): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.document(type));
}

export async function readDocumentVersions(
  type: DocumentType,
): Promise<{ versions: DocumentVersionSummary[] }> {
  return apiFetch<{ versions: DocumentVersionSummary[] }>(DOCUMENT_ROUTES.versions(type));
}

export async function readDocumentDiff(
  type: DocumentType,
  left: number,
  right: number,
): Promise<{ diff: DocumentDiff }> {
  return apiFetch<{ diff: DocumentDiff }>(
    `${DOCUMENT_ROUTES.compare(type)}?left=${left}&right=${right}`,
  );
}

export async function readFeatures(type: DocumentType): Promise<{ features: FeatureRow[] }> {
  return apiFetch<{ features: FeatureRow[] }>(DOCUMENT_ROUTES.features(type));
}

export async function readFeatureCsv(type: DocumentType): Promise<{ csv: string }> {
  return apiFetch<{ csv: string }>(DOCUMENT_ROUTES.csv(type));
}

export async function readDocumentRun(type: DocumentType): Promise<DocumentRun | null> {
  return apiFetch<DocumentRun | null>(DOCUMENT_ROUTES.currentRun(type));
}

export async function generateDocument(
  type: DocumentType,
  request: GenerateDocument,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.generate(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function updateDocumentSection(
  type: DocumentType,
  sectionId: string,
  request: UpdateSection,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.section(type, sectionId), {
    method: 'PUT',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function regenerateDocumentSection(
  type: DocumentType,
  sectionId: string,
  request: RegenerateSection,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.regenerateSection(type, sectionId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resolveSectionProposal(
  type: DocumentType,
  sectionId: string,
  request: ResolveSectionProposal,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.resolveProposal(type, sectionId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function updateFeature(
  type: DocumentType,
  featureId: string,
  request: UpdateFeatureRow,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.feature(type, featureId), {
    method: 'PATCH',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function excludeRequirement(
  type: DocumentType,
  request: { requirementId: string; reason: string; expectedVersion: number },
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.excludeRequirement(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function validateDocument(type: DocumentType, useAi: boolean): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.validate(type), {
    method: 'POST',
    body: { useAi },
    headers: mutationHeaders(),
  });
}

export async function acknowledgeDocumentFinding(
  type: DocumentType,
  request: AcknowledgeFinding,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.acknowledgeFinding(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function approveDocument(
  type: DocumentType,
  request: ApproveDocument,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.approve(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function reopenDocument(
  type: DocumentType,
  request: ReopenDocument,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.reopen(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function markDocumentFinal(
  type: DocumentType,
  request: MarkFinal,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.markFinal(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function restoreDocumentVersion(
  type: DocumentType,
  request: RestoreVersion,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.restore(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}
