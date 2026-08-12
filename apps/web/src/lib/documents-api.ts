import {
  type AddRow,
  type ConfirmAssumption,
  type EditRow,
  type ExcludeRow,
  type RegenerateRow,
  type RegenerateRowGroup,
  type RejectAssumption,
  type ResolveRowProposal,
  type ReceiveDependency,
  type RequestDependency,
  type SettleAssumption,
  type ValidateDependency,
  DOCUMENT_ROUTES,
  type AcknowledgeFinding,
  type ApplyCorrection,
  type ApproveDocument,
  type CorrectionInstruction,
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
  type ResolveFeatureProposal,
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

export async function applyCorrection(
  type: DocumentType,
  request: ApplyCorrection,
): Promise<DocumentView & { limits: string[] }> {
  return apiFetch<DocumentView & { limits: string[] }>(DOCUMENT_ROUTES.corrections(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function readCorrections(
  type: DocumentType,
): Promise<{ corrections: CorrectionInstruction[] }> {
  return apiFetch<{ corrections: CorrectionInstruction[] }>(DOCUMENT_ROUTES.corrections(type));
}

export async function regenerateFeature(
  type: DocumentType,
  featureId: string,
  request: RegenerateSection,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.regenerateFeature(type, featureId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function regenerateModule(
  type: DocumentType,
  request: { module: string; instruction?: string; useAi: boolean; expectedVersion: number },
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.regenerateModule(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resolveFeatureProposal(
  type: DocumentType,
  featureId: string,
  request: ResolveFeatureProposal,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.resolveFeatureProposal(type, featureId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function reviseDocument(
  type: DocumentType,
  request: ReopenDocument,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.revise(type), {
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

/* ------------------------------------- Phase 8: structured rows ---------- */

/*
 * One set of row calls for every list document. Acceptance Criteria and
 * Assumptions share them; the row kind follows from the document type.
 */

export async function addRow(type: DocumentType, request: AddRow): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.addRow(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function updateRow(
  type: DocumentType,
  rowId: string,
  request: EditRow,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.row(type, rowId), {
    method: 'PATCH',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function regenerateRow(
  type: DocumentType,
  rowId: string,
  request: RegenerateRow,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.regenerateRow(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function regenerateRowGroup(
  type: DocumentType,
  request: RegenerateRowGroup,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.regenerateRowGroup(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function resolveRowProposal(
  type: DocumentType,
  rowId: string,
  request: ResolveRowProposal,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.resolveRowProposal(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function excludeRow(
  type: DocumentType,
  rowId: string,
  request: ExcludeRow,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.excludeRow(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

/* ---------------------------------------- Phase 8: assumptions ----------- */

export async function confirmAssumption(
  type: DocumentType,
  rowId: string,
  request: ConfirmAssumption,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.confirmAssumption(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function rejectAssumption(
  type: DocumentType,
  rowId: string,
  request: RejectAssumption,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.rejectAssumption(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function settleAssumption(
  type: DocumentType,
  rowId: string,
  request: SettleAssumption,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.settleAssumption(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function requestAssumptionCandidates(
  type: DocumentType,
  request: GenerateDocument,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.assumptionCandidates(type), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

/* --------------------------------- Phase 9: client dependencies ---------- */

/**
 * The three lifecycle actions, as three calls.
 *
 * `receive` and `validate` are deliberately not one request. Something that arrived is
 * not something that works, and a single call would let the interface offer "mark as
 * received and accepted", which is the shortcut the whole status model exists to
 * prevent.
 */
export async function requestDependency(
  type: DocumentType,
  rowId: string,
  request: RequestDependency,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.requestDependency(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function receiveDependency(
  type: DocumentType,
  rowId: string,
  request: ReceiveDependency,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.receiveDependency(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}

export async function validateDependency(
  type: DocumentType,
  rowId: string,
  request: ValidateDependency,
): Promise<DocumentView> {
  return apiFetch<DocumentView>(DOCUMENT_ROUTES.validateDependency(type, rowId), {
    method: 'POST',
    body: request,
    headers: mutationHeaders(),
  });
}
