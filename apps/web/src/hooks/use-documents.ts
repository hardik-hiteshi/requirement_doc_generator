'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddRow,
  ConfirmAssumption,
  EditRow,
  ExcludeRow,
  RegenerateRow,
  RegenerateRowGroup,
  RejectAssumption,
  ResolveRowProposal,
  SettleAssumption,
  AcknowledgeFinding,
  ApplyCorrection,
  ApproveDocument,
  DocumentType,
  GenerateDocument,
  MarkFinal,
  RegenerateSection,
  ReopenDocument,
  ResolveFeatureProposal,
  ResolveSectionProposal,
  RestoreVersion,
  UpdateFeatureRow,
  UpdateSection,
} from '@wdrg/contracts';
import { useCallback } from 'react';

import {
  addRow,
  confirmAssumption,
  excludeRow,
  regenerateRow,
  regenerateRowGroup,
  rejectAssumption,
  requestAssumptionCandidates,
  resolveRowProposal,
  settleAssumption,
  updateRow,
  acknowledgeDocumentFinding,
  applyCorrection,
  approveDocument,
  excludeRequirement,
  generateDocument,
  markDocumentFinal,
  readDocument,
  readDocumentDiff,
  readDocumentRun,
  readDocuments,
  readDocumentVersions,
  readCorrections,
  readFeatureCsv,
  regenerateDocumentSection,
  regenerateFeature,
  regenerateModule,
  resolveFeatureProposal,
  reviseDocument,
  reopenDocument,
  resolveSectionProposal,
  restoreDocumentVersion,
  updateDocumentSection,
  updateFeature,
  validateDocument,
  type DocumentView,
} from '@/lib/documents-api';
import { queryKeys } from '@/lib/query-keys';

/**
 * Phase 7 data, and the mutations that change it.
 *
 * The same convention as Phases 5 and 6: **every mutation returns the whole
 * document and seeds the cache with it.** Editing one section moves the
 * validation result, the blockers, whether approval is possible and — through the
 * dependency graph — the state of the document below it. A mutation returning
 * only what it touched would leave the screen showing an approval button that no
 * longer applies.
 *
 * The document list is invalidated alongside, because approving one document
 * unlocks another.
 */

export function useDocuments() {
  return useQuery({
    queryKey: queryKeys.documents,
    queryFn: readDocuments,
    /*
     * Always refetched, overriding the application's 30-second default. This
     * list's answer depends on things changed in earlier steps — a baseline
     * re-approved, a stack unlocked — and a cached "Feature Listing is unlocked"
     * is not slow, it is wrong.
     */
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useDocument(type: DocumentType) {
  return useQuery({
    queryKey: queryKeys.document(type),
    queryFn: () => readDocument(type),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useDocumentVersions(type: DocumentType) {
  return useQuery({
    queryKey: queryKeys.documentVersions(type),
    queryFn: () => readDocumentVersions(type),
    staleTime: 0,
  });
}

export function useDocumentDiff(type: DocumentType, left: number | null, right: number | null) {
  return useQuery({
    queryKey: queryKeys.documentDiff(type, left ?? 0, right ?? 0),
    queryFn: () => readDocumentDiff(type, left!, right!),
    enabled: left !== null && right !== null && left !== right,
    staleTime: 0,
  });
}

export function useFeatureCsv(type: DocumentType, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.documentCsv(type),
    queryFn: () => readFeatureCsv(type),
    enabled,
    staleTime: 0,
  });
}

export function useDocumentRun(type: DocumentType) {
  return useQuery({
    queryKey: queryKeys.documentRun(type),
    queryFn: () => readDocumentRun(type),
    staleTime: 0,
  });
}

/** Seeds the document cache and invalidates everything that depends on it. */
function useDocumentMutation<TInput>(
  type: DocumentType,
  run: (input: TInput) => Promise<DocumentView>,
) {
  const client = useQueryClient();

  const onSuccess = useCallback(
    (view: DocumentView) => {
      client.setQueryData(queryKeys.document(type), view);
      void client.invalidateQueries({ queryKey: queryKeys.documents });
      void client.invalidateQueries({ queryKey: queryKeys.documentVersions(type) });
      void client.invalidateQueries({ queryKey: queryKeys.documentCsv(type) });
    },
    [client, type],
  );

  return useMutation({ mutationFn: run, onSuccess });
}

export function useGenerateDocument(type: DocumentType) {
  return useDocumentMutation(type, (request: GenerateDocument) => generateDocument(type, request));
}

export function useUpdateSection(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ sectionId, ...request }: UpdateSection & { sectionId: string }) =>
      updateDocumentSection(type, sectionId, request),
  );
}

export function useRegenerateSection(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ sectionId, ...request }: RegenerateSection & { sectionId: string }) =>
      regenerateDocumentSection(type, sectionId, request),
  );
}

export function useResolveProposal(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ sectionId, ...request }: ResolveSectionProposal & { sectionId: string }) =>
      resolveSectionProposal(type, sectionId, request),
  );
}

export function useUpdateFeature(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ featureId, ...request }: UpdateFeatureRow & { featureId: string }) =>
      updateFeature(type, featureId, request),
  );
}

export function useExcludeRequirement(type: DocumentType) {
  return useDocumentMutation(
    type,
    (request: { requirementId: string; reason: string; expectedVersion: number }) =>
      excludeRequirement(type, request),
  );
}

export function useValidateDocument(type: DocumentType) {
  return useDocumentMutation(type, (useAi: boolean) => validateDocument(type, useAi));
}

export function useAcknowledgeFinding(type: DocumentType) {
  return useDocumentMutation(type, (request: AcknowledgeFinding) =>
    acknowledgeDocumentFinding(type, request),
  );
}

export function useApproveDocument(type: DocumentType) {
  return useDocumentMutation(type, (request: ApproveDocument) => approveDocument(type, request));
}

export function useReopenDocument(type: DocumentType) {
  return useDocumentMutation(type, (request: ReopenDocument) => reopenDocument(type, request));
}

export function useMarkFinal(type: DocumentType) {
  return useDocumentMutation(type, (request: MarkFinal) => markDocumentFinal(type, request));
}

export function useCorrections(type: DocumentType) {
  return useQuery({
    queryKey: queryKeys.documentCorrections(type),
    queryFn: () => readCorrections(type),
    staleTime: 0,
  });
}

/**
 * Applying a correction.
 *
 * Returns the document *and* anything the correction could not do, so the screen
 * can say "this part of what you asked cannot be done here, and here is where it
 * is done" rather than quietly applying half of it.
 */
export function useApplyCorrection(type: DocumentType) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (request: ApplyCorrection) => applyCorrection(type, request),
    onSuccess: (view) => {
      client.setQueryData(queryKeys.document(type), { document: view.document });
      void client.invalidateQueries({ queryKey: queryKeys.documents });
      void client.invalidateQueries({ queryKey: queryKeys.documentVersions(type) });
      void client.invalidateQueries({ queryKey: queryKeys.documentCorrections(type) });
      void client.invalidateQueries({ queryKey: queryKeys.documentCsv(type) });
    },
  });
}

export function useRegenerateFeature(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ featureId, ...request }: RegenerateSection & { featureId: string }) =>
      regenerateFeature(type, featureId, request),
  );
}

export function useRegenerateModule(type: DocumentType) {
  return useDocumentMutation(
    type,
    (request: { module: string; instruction?: string; useAi: boolean; expectedVersion: number }) =>
      regenerateModule(type, request),
  );
}

export function useResolveFeatureProposal(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ featureId, ...request }: ResolveFeatureProposal & { featureId: string }) =>
      resolveFeatureProposal(type, featureId, request),
  );
}

export function useReviseDocument(type: DocumentType) {
  return useDocumentMutation(type, (request: ReopenDocument) => reviseDocument(type, request));
}

export function useRestoreVersion(type: DocumentType) {
  return useDocumentMutation(type, (request: RestoreVersion) =>
    restoreDocumentVersion(type, request),
  );
}

/* ------------------------------------- Phase 8: structured rows ---------- */

export function useAddRow(type: DocumentType) {
  return useDocumentMutation(type, (request: AddRow) => addRow(type, request));
}

export function useUpdateRow(type: DocumentType) {
  return useDocumentMutation(type, ({ rowId, ...request }: EditRow & { rowId: string }) =>
    updateRow(type, rowId, request),
  );
}

export function useRegenerateRow(type: DocumentType) {
  return useDocumentMutation(type, ({ rowId, ...request }: RegenerateRow & { rowId: string }) =>
    regenerateRow(type, rowId, request),
  );
}

export function useRegenerateRowGroup(type: DocumentType) {
  return useDocumentMutation(type, (request: RegenerateRowGroup) =>
    regenerateRowGroup(type, request),
  );
}

export function useResolveRowProposal(type: DocumentType) {
  return useDocumentMutation(
    type,
    ({ rowId, ...request }: ResolveRowProposal & { rowId: string }) =>
      resolveRowProposal(type, rowId, request),
  );
}

export function useExcludeRow(type: DocumentType) {
  return useDocumentMutation(type, ({ rowId, ...request }: ExcludeRow & { rowId: string }) =>
    excludeRow(type, rowId, request),
  );
}

/* ---------------------------------------- Phase 8: assumptions ----------- */

export function useConfirmAssumption(type: DocumentType) {
  return useDocumentMutation(type, ({ rowId, ...request }: ConfirmAssumption & { rowId: string }) =>
    confirmAssumption(type, rowId, request),
  );
}

export function useRejectAssumption(type: DocumentType) {
  return useDocumentMutation(type, ({ rowId, ...request }: RejectAssumption & { rowId: string }) =>
    rejectAssumption(type, rowId, request),
  );
}

export function useSettleAssumption(type: DocumentType) {
  return useDocumentMutation(type, ({ rowId, ...request }: SettleAssumption & { rowId: string }) =>
    settleAssumption(type, rowId, request),
  );
}

export function useAssumptionCandidates(type: DocumentType) {
  return useDocumentMutation(type, (request: GenerateDocument) =>
    requestAssumptionCandidates(type, request),
  );
}
