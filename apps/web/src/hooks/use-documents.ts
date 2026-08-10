'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcknowledgeFinding,
  ApproveDocument,
  DocumentType,
  GenerateDocument,
  MarkFinal,
  RegenerateSection,
  ReopenDocument,
  ResolveSectionProposal,
  RestoreVersion,
  UpdateFeatureRow,
  UpdateSection,
} from '@wdrg/contracts';
import { useCallback } from 'react';

import {
  acknowledgeDocumentFinding,
  approveDocument,
  excludeRequirement,
  generateDocument,
  markDocumentFinal,
  readDocument,
  readDocumentDiff,
  readDocumentRun,
  readDocuments,
  readDocumentVersions,
  readFeatureCsv,
  regenerateDocumentSection,
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

export function useRestoreVersion(type: DocumentType) {
  return useDocumentMutation(type, (request: RestoreVersion) =>
    restoreDocumentVersion(type, request),
  );
}
