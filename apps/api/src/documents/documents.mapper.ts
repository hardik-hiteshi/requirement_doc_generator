import {
  DOCUMENT_SCHEMA_VERSION,
  type DocumentBlocker,
  type DocumentReference,
  type DocumentRun,
  type DocumentSection,
  type DocumentSnapshot,
  type DocumentStatus,
  type DocumentType,
  type DocumentValidation,
  type DocumentVersionSummary,
  type EffortReconciliation,
  type FeatureCoverage,
  type FeatureRow,
} from '@wdrg/contracts';

import type {
  DocumentDocument,
  DocumentFeatureDocument,
  DocumentRunDocument,
  DocumentSectionDocument,
  DocumentVersionDocument,
} from './schemas/document.schema';

/**
 * Stored documents into wire shapes.
 *
 * Mapping is explicit rather than a spread, for the reason every mapper in this
 * repository is: a stored field added later must not appear in an API response
 * because nobody remembered to exclude it. The compiler checks the shape; this
 * file decides what is in it.
 *
 * An empty string in storage becomes an absent optional field on the wire.
 * Mongoose treats `''` as absent for a `required` String, so optional text is
 * stored as `''` and defaulted — which would otherwise surface as
 * `"omittedReason": ""` and read as an empty explanation rather than none.
 */

export interface StoredContent {
  readonly sections: readonly DocumentSection[];
  readonly features: readonly FeatureRow[];
  readonly version: number;
  readonly status: DocumentStatus;
}

export interface AssembledExtras {
  readonly status?: DocumentStatus;
  readonly blockers?: readonly DocumentBlocker[];
  readonly outdatedReasons?: DocumentSnapshot['outdatedReasons'];
  readonly coverage?: FeatureCoverage | null;
  readonly reconciliation?: EffortReconciliation | null;
}

export function toSection(record: DocumentSectionDocument): DocumentSection {
  return {
    sectionId: record.sectionId,
    key: record.key,
    title: record.title,
    order: record.order,
    body: record.body,
    origin: record.origin as DocumentSection['origin'],
    ...(record.omittedReason ? { omittedReason: record.omittedReason } : {}),
    references: record.references as unknown as DocumentReference[],
    ...(record.proposedBody ? { proposedBody: record.proposedBody } : {}),
    ...(record.proposedAt ? { proposedAt: record.proposedAt.toISOString() } : {}),
    ...(record.regenerationReason ? { regenerationReason: record.regenerationReason } : {}),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toFeatureRow(record: DocumentFeatureDocument): FeatureRow {
  return {
    featureId: record.featureId,
    requirementIds: [...record.requirementIds],
    module: record.module,
    submodule: record.submodule,
    screen: record.screen,
    description: record.description,
    effort: { ...record.effort },
    totalHours: record.totalHours,
    estimateUnitIds: [...record.estimateUnitIds],
    technologyIds: [...record.technologyIds],
    references: record.references as unknown as DocumentReference[],
    reviewStatus: record.reviewStatus as FeatureRow['reviewStatus'],
    mappingConfidence: record.mappingConfidence,
    notes: record.notes,
    order: record.order,
    ...(record.proposed ? { proposed: record.proposed as FeatureRow['proposed'] } : {}),
    ...(record.proposedAt ? { proposedAt: record.proposedAt.toISOString() } : {}),
  };
}

/**
 * A wire row back into a storable record.
 *
 * Explicit rather than a spread, because the two shapes disagree about time: the
 * wire carries `proposedAt` as an ISO string and the record as a `Date`. Spreading
 * one into the other type-checks nowhere and, worse, would store a string in a
 * date field if the types were loose.
 */
export function toFeatureRecord(
  row: FeatureRow,
  documentVersion: number,
  overrides: {
    readonly featureId?: string;
    readonly proposed?: Record<string, string> | null;
    readonly proposedAt?: Date;
  } = {},
): Record<string, unknown> {
  return {
    featureId: overrides.featureId ?? row.featureId,
    documentVersion,
    requirementIds: [...row.requirementIds],
    module: row.module,
    submodule: row.submodule,
    screen: row.screen,
    description: row.description,
    effort: { ...row.effort },
    totalHours: row.totalHours,
    estimateUnitIds: [...row.estimateUnitIds],
    technologyIds: [...row.technologyIds],
    references: row.references,
    reviewStatus: row.reviewStatus,
    mappingConfidence: row.mappingConfidence,
    notes: row.notes,
    order: row.order,
    proposed: overrides.proposed ?? null,
    ...(overrides.proposedAt ? { proposedAt: overrides.proposedAt } : {}),
  };
}

export function toDocumentSnapshot(
  record: DocumentDocument,
  content: StoredContent,
  extras: AssembledExtras = {},
): DocumentSnapshot {
  return {
    documentId: record.documentId,
    type: record.type as DocumentType,
    projectId: record.projectId,
    version: content.version,
    status: extras.status ?? content.status,
    title: record.title,
    ...(record.baselineId ? { baselineId: record.baselineId } : {}),
    ...(record.baselineVersion !== undefined ? { baselineVersion: record.baselineVersion } : {}),
    ...(record.stackSnapshotId ? { stackSnapshotId: record.stackSnapshotId } : {}),
    ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
    ...(record.estimateSnapshotId ? { estimateSnapshotId: record.estimateSnapshotId } : {}),
    ...(record.estimateVersion !== undefined ? { estimateVersion: record.estimateVersion } : {}),
    prerequisiteVersions: { ...record.prerequisiteVersions },
    sections: [...content.sections],
    features: [...content.features],
    validation: (record.validation as unknown as DocumentValidation | null) ?? null,
    blockers: [...(extras.blockers ?? (record.blockers as unknown as DocumentBlocker[]))],
    outdatedReasons: [
      ...(extras.outdatedReasons ??
        (record.outdatedReasons as unknown as DocumentSnapshot['outdatedReasons'])),
    ],
    coverage: extras.coverage ?? (record.coverage as unknown as FeatureCoverage | null) ?? null,
    reconciliation:
      extras.reconciliation ??
      (record.reconciliation as unknown as EffortReconciliation | null) ??
      null,
    generator: (record.generator as unknown as DocumentSnapshot['generator']) ?? null,
    ...(record.regenerationReason ? { regenerationReason: record.regenerationReason } : {}),
    ...(record.supersedesVersion !== undefined
      ? { supersedesVersion: record.supersedesVersion }
      : {}),
    schemaVersion: record.schemaVersion ?? DOCUMENT_SCHEMA_VERSION,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(record.approvedAt ? { approvedAt: record.approvedAt.toISOString() } : {}),
    ...(record.finalAt ? { finalAt: record.finalAt.toISOString() } : {}),
    recordVersion: record.recordVersion,
  };
}

export function toVersionSummary(record: DocumentVersionDocument): DocumentVersionSummary {
  const sections = record.sections as unknown as DocumentSection[];
  const features = record.features as unknown as FeatureRow[];

  return {
    version: record.version,
    status: record.status as DocumentStatus,
    createdAt: record.createdAt.toISOString(),
    ...(record.approvedAt ? { approvedAt: record.approvedAt.toISOString() } : {}),
    ...(record.finalAt ? { finalAt: record.finalAt.toISOString() } : {}),
    ...(record.baselineVersion !== undefined ? { baselineVersion: record.baselineVersion } : {}),
    ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
    ...(record.estimateVersion !== undefined ? { estimateVersion: record.estimateVersion } : {}),
    contentCount: sections.length + features.length,
    userEditedCount: sections.filter((section) => section.origin !== 'GENERATED').length,
    ...(record.regenerationReason ? { regenerationReason: record.regenerationReason } : {}),
    validationSeverity: (record.validation as { severity?: string } | null)?.severity ?? null,
  };
}

export function toDocumentRun(record: DocumentRunDocument): DocumentRun {
  return {
    runId: record.runId,
    projectId: record.projectId,
    type: record.type as DocumentType,
    kind: record.kind as DocumentRun['kind'],
    status: record.status as DocumentRun['status'],
    ...(record.baselineVersion !== undefined ? { baselineVersion: record.baselineVersion } : {}),
    ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
    ...(record.estimateVersion !== undefined ? { estimateVersion: record.estimateVersion } : {}),
    provider: record.provider,
    model: record.modelName,
    promptVersions: { ...record.promptVersions },
    sectionKeys: [...record.sectionKeys],
    inputCharacters: record.inputCharacters,
    outputCharacters: record.outputCharacters,
    retries: record.retries,
    startedAt: record.startedAt.toISOString(),
    ...(record.completedAt ? { completedAt: record.completedAt.toISOString() } : {}),
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    deterministicOnly: record.deterministicOnly,
  };
}
