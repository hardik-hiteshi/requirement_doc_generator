import {
  DOCUMENT_SCHEMA_VERSION,
  type DocumentBlocker,
  type DocumentReference,
  type DocumentRun,
  type DocumentSection,
  type DocumentSnapshot,
  type DocumentCurrentness,
  type DocumentStatus,
  type DocumentType,
  type DocumentValidation,
  type DocumentVersionSummary,
  type AssumptionSummary,
  type CriteriaCoverage,
  type DocumentRow,
  type EffortReconciliation,
  type FeatureCoverage,
  type FeatureRow,
  type ContentEntry,
  type DependencySummary,
  type DiffChangeKind,
  type DocumentChangeType,
  type ReverseDependencyIndex,
  type SowScopeReconciliation,
  type WbsCoverage,
  type WbsReconciliation,
} from '@wdrg/contracts';

import type {
  DocumentDocument,
  DocumentFeatureDocument,
  DocumentRowDocument,
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
  readonly rows: readonly DocumentRow[];
  readonly version: number;
  readonly status: DocumentStatus;
}

export interface AssembledExtras {
  readonly status?: DocumentStatus;
  readonly currentness?: DocumentCurrentness;
  readonly rows?: readonly DocumentRow[];
  readonly criteriaCoverage?: CriteriaCoverage | null;
  readonly assumptionSummary?: AssumptionSummary | null;
  readonly scopeReconciliation?: SowScopeReconciliation | null;
  readonly wbsReconciliation?: WbsReconciliation | null;
  readonly wbsCoverage?: WbsCoverage | null;
  readonly dependencySummary?: DependencySummary | null;
  readonly reverseDependencies?: ReverseDependencyIndex | null;
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

/**
 * One string field of a row payload, safely.
 *
 * A payload is `unknown` to the engine by design — only the document's own schema
 * knows its shape — so reading a field for a label or a fingerprint goes through
 * here rather than through `String()`, which would render an object as
 * `[object Object]` and quietly produce nonsense.
 */
export function payloadText(payload: unknown, field: string): string {
  if (typeof payload !== 'object' || payload === null) {
    return '';
  }

  const value = (payload as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : '';
}

/** A stored row, in the shape the wire uses. */
export function toRow(record: DocumentRowDocument): DocumentRow {
  return {
    rowId: record.rowId,
    kind: record.kind as DocumentRow['kind'],
    order: record.order,
    origin: record.origin as DocumentRow['origin'],
    ...(record.attribution ? { attribution: record.attribution } : {}),
    ...(record.proposed ? { proposed: record.proposed } : {}),
    ...(record.proposedAt ? { proposedAt: record.proposedAt.toISOString() } : {}),
    references: record.references as unknown as DocumentReference[],
    ...(record.excludedReason ? { excludedReason: record.excludedReason } : {}),
    payload: record.payload,
    updatedAt: record.updatedAt.toISOString(),
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
    /*
     * Defaulted to CURRENT rather than derived here: this mapper has no upstream
     * state to compare against. Every caller that has one passes it.
     */
    currentness: extras.currentness ?? 'CURRENT',
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
    /*
     * From `extras` when the caller has assembled them, otherwise from the content
     * itself. Taking them only from `extras` meant every historical version read back
     * with no rows at all — so four of the seven documents had an unreadable history
     * and an empty comparison, while looking fine.
     */
    rows: [...(extras.rows ?? content.rows)],
    criteriaCoverage: extras.criteriaCoverage ?? null,
    assumptionSummary: extras.assumptionSummary ?? null,
    scopeReconciliation: extras.scopeReconciliation ?? null,
    wbsReconciliation: extras.wbsReconciliation ?? null,
    wbsCoverage: extras.wbsCoverage ?? null,
    dependencySummary: extras.dependencySummary ?? null,
    reverseDependencies: extras.reverseDependencies ?? null,
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

/**
 * A stored version, with its currentness judged against today's upstream.
 *
 * The version's own recorded upstream versions are what it is judged on, so the
 * history can say "the version we issued in March is no longer current" without
 * anybody touching the March document.
 */
export function toVersionSummary(
  record: DocumentVersionDocument,
  currentness: DocumentCurrentness = 'CURRENT',
): DocumentVersionSummary {
  const sections = record.sections as unknown as DocumentSection[];
  const features = record.features as unknown as FeatureRow[];

  return {
    version: record.version,
    status: record.status as DocumentStatus,
    currentness,
    createdAt: record.createdAt.toISOString(),
    ...(record.approvedAt ? { approvedAt: record.approvedAt.toISOString() } : {}),
    ...(record.finalAt ? { finalAt: record.finalAt.toISOString() } : {}),
    ...(record.baselineVersion !== undefined ? { baselineVersion: record.baselineVersion } : {}),
    ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
    ...(record.estimateVersion !== undefined ? { estimateVersion: record.estimateVersion } : {}),
    /* Rows count too: four of the seven documents have no sections at all. */
    contentCount: sections.length + features.length + (record.rows?.length ?? 0),
    userEditedCount: sections.filter((section) => section.origin !== 'GENERATED').length,
    ...(record.regenerationReason ? { regenerationReason: record.regenerationReason } : {}),
    validationSeverity: (record.validation as { severity?: string } | null)?.severity ?? null,
    ...(record.changeType ? { changeType: record.changeType as DocumentChangeType } : {}),
    ...(record.restoredFromVersion !== undefined
      ? { restoredFromVersion: record.restoredFromVersion }
      : {}),
    ...(record.revisedFromVersion !== undefined
      ? { revisedFromVersion: record.revisedFromVersion }
      : {}),
    ...(record.actor ? { actor: record.actor } : {}),
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

/* --------------------------------------------- Phase 10: comparable fields */

/**
 * The fields of a row, as a reader compares them.
 *
 * Two decisions here carry the weight.
 *
 * **Each field says what kind of change it represents.** An acceptance criterion
 * whose wording was rewritten and one that now cites a different requirement are
 * both "changed", and a reviewer deciding whether to re-approve needs to know which.
 * `TRACEABILITY` marks the citation fields, `LIFECYCLE` the status ones, `CONTENT`
 * the words and figures.
 *
 * **Values are rendered as text.** A diff is read by a person, so an array of
 * requirement keys becomes "REQ-001, REQ-004" rather than JSON. Nothing here is
 * parsed back — this projection is for comparison only.
 */
type ComparableField = NonNullable<ContentEntry['fields']>[number];

/** One value, as a person reads it in a comparison. */
function renderValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderValue(entry)).join(', ');
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  /* eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitives only by here. */
  return String(value);
}

const field = (
  name: string,
  label: string,
  changeKind: DiffChangeKind,
  value: unknown,
): ComparableField => ({
  field: name,
  label,
  changeKind,
  /*
   * Rendered for a person to read, so an array becomes "REQ-001, REQ-004" and an
   * object becomes JSON rather than "[object Object]". Nothing here is parsed back:
   * this projection exists only to be compared and displayed.
   */
  value: renderValue(value),
});

/** A row's heading in a comparison: its key and what it is about. */
export function rowTitle(row: DocumentRow): string {
  const payload = row.payload as Record<string, unknown>;
  const key =
    payloadText(payload, 'criterionKey') ||
    payloadText(payload, 'assumptionKey') ||
    payloadText(payload, 'wbsId') ||
    payloadText(payload, 'dependencyKey');

  const subject =
    payloadText(payload, 'statement') ||
    payloadText(payload, 'then') ||
    payloadText(payload, 'task') ||
    payloadText(payload, 'dependency') ||
    payloadText(payload, 'feature');

  return [key, subject].filter(Boolean).join(' — ').slice(0, 300);
}

/** One line summarising a row, for the collapsed view of a comparison. */
export function rowSummary(row: DocumentRow): string {
  return (rowFields(row) ?? [])
    .filter((entry) => entry.changeKind === 'CONTENT' && entry.value.length > 0)
    .map((entry) => entry.value)
    .join(' · ')
    .slice(0, 20_000);
}

/** Comparable fields for a Feature Listing row. */
export function featureFields(feature: FeatureRow): readonly ComparableField[] {
  return [
    field('module', 'Module', 'CONTENT', feature.module),
    field('submodule', 'Sub module', 'CONTENT', feature.submodule),
    field('screen', 'Screen', 'CONTENT', feature.screen),
    field('description', 'Description', 'CONTENT', feature.description),
    field('totalHours', 'Hours', 'CONTENT', feature.totalHours),
    field('requirementIds', 'Requirements', 'TRACEABILITY', feature.requirementIds),
    field('estimateUnitIds', 'Estimate items', 'TRACEABILITY', feature.estimateUnitIds),
    field('technologyIds', 'Technologies', 'TRACEABILITY', feature.technologyIds),
    field('reviewStatus', 'Review state', 'LIFECYCLE', feature.reviewStatus),
  ];
}

/**
 * Comparable fields for a row in the generic channel.
 *
 * Per document kind, because the fields that matter differ: a criterion's `then` is
 * its substance, an assumption's `status` is its authority, a work package's hours
 * are what somebody will plan against, and a dependency's status is whether the
 * project is blocked.
 */
export function rowFields(row: DocumentRow): readonly ComparableField[] {
  const payload = row.payload as Record<string, unknown>;

  const shared = [
    field('origin', 'Where it came from', 'LIFECYCLE', row.origin),
    field('excludedReason', 'Excluded because', 'LIFECYCLE', row.excludedReason ?? ''),
  ];

  if (row.kind === 'ACCEPTANCE_CRITERION') {
    return [
      field('aspect', 'Kind of condition', 'CONTENT', payload.aspect),
      field('given', 'Given', 'CONTENT', payload.given),
      field('when', 'When', 'CONTENT', payload.when),
      field('then', 'Then', 'CONTENT', payload.then),
      field('rule', 'Rule', 'CONTENT', payload.rule),
      field('module', 'Module', 'CONTENT', payload.module),
      field('requirementIds', 'Requirements', 'TRACEABILITY', payload.requirementIds),
      field('featureIds', 'Features', 'TRACEABILITY', payload.featureIds),
      field('status', 'Status', 'LIFECYCLE', payload.status),
      ...shared,
    ];
  }

  if (row.kind === 'ASSUMPTION') {
    return [
      field('statement', 'Assumption', 'CONTENT', payload.statement),
      field('category', 'Category', 'CONTENT', payload.category),
      field('impact', 'Impact', 'CONTENT', payload.impact),
      field('impactIfFalse', 'If it is wrong', 'CONTENT', payload.impactIfFalse),
      field('validationNeeded', 'How to check it', 'CONTENT', payload.validationNeeded),
      field('requirementIds', 'Requirements', 'TRACEABILITY', payload.requirementIds),
      field('status', 'Status', 'LIFECYCLE', payload.status),
      field('provenance', 'Who stands behind it', 'LIFECYCLE', payload.provenance),
      field('owner', 'Owner', 'LIFECYCLE', payload.owner),
      ...shared,
    ];
  }

  if (row.kind === 'WORK_PACKAGE') {
    return [
      field('level', 'Level', 'CONTENT', payload.level),
      field('workKind', 'Kind of work', 'CONTENT', payload.workKind),
      field('task', 'Task', 'CONTENT', payload.task),
      field('description', 'What it involves', 'CONTENT', payload.description),
      field('deliverable', 'What it produces', 'CONTENT', payload.deliverable),
      field('totalEffort', 'Hours', 'CONTENT', payload.totalEffort),
      field('ownerRole', 'Role', 'CONTENT', payload.ownerRole),
      field('relativeStartDay', 'Starts on working day', 'AUTHORITY', payload.relativeStartDay),
      field('relativeFinishDay', 'Finishes on working day', 'AUTHORITY', payload.relativeFinishDay),
      field('onCriticalPath', 'On the critical path', 'AUTHORITY', payload.onCriticalPath),
      field('predecessors', 'After', 'CONTENT', payload.predecessors),
      field('requirementIds', 'Requirements', 'TRACEABILITY', payload.requirementIds),
      field('featureIds', 'Features', 'TRACEABILITY', payload.featureIds),
      field('estimateUnitIds', 'Estimate items', 'TRACEABILITY', payload.estimateUnitIds),
      field('status', 'Status', 'LIFECYCLE', payload.status),
      ...shared,
    ];
  }

  if (row.kind === 'CLIENT_DEPENDENCY') {
    return [
      field('category', 'Category', 'CONTENT', payload.category),
      field('dependency', 'What is needed', 'CONTENT', payload.dependency),
      field('description', 'Description', 'CONTENT', payload.description),
      field('purpose', 'Why', 'CONTENT', payload.purpose),
      field('expectedFormat', 'What good looks like', 'CONTENT', payload.expectedFormat),
      field('impactIfDelayed', 'If it is late', 'CONTENT', payload.impactIfDelayed),
      field('relativeDue', 'Needed by', 'CONTENT', payload.relativeDue),
      field('priority', 'Priority', 'CONTENT', payload.priority),
      field('blocking', 'What it blocks', 'CONTENT', payload.blocking),
      field('clientOwner', 'Your owner', 'CONTENT', payload.clientOwner),
      field('internalOwner', 'Our owner', 'CONTENT', payload.internalOwner),
      field('requirementIds', 'Requirements', 'TRACEABILITY', payload.requirementIds),
      field('wbsIds', 'Work packages', 'TRACEABILITY', payload.wbsIds),
      field('status', 'Status', 'LIFECYCLE', payload.status),
      field('validationNote', 'What the check showed', 'LIFECYCLE', payload.validationNote),
      ...shared,
    ];
  }

  return shared;
}
