import type {
  CategoryApplicabilityEntry,
  CompatibilityFinding,
  RecommendationRun,
  StackBlocker,
  StackComponent,
  StackDecision,
  StackSnapshot,
} from '@wdrg/contracts';

import type {
  RecommendationRunDocument,
  StackComponentDocument,
  StackSnapshotDocument,
} from './schemas/stack.schema';

/**
 * Stored documents into the shapes the contract describes.
 *
 * One place, so no controller assembles a response by hand and no Mongo
 * internal — `_id`, `__v`, a `Date` object — reaches a client by accident. The
 * casts here are the boundary where loosely-typed stored objects become the
 * contract's types; every one of them corresponds to a field written by code in
 * this module that the schema validates on the way out.
 */

export function toComponent(document: StackComponentDocument): StackComponent {
  return {
    id: document.componentId,
    category: document.category as StackComponent['category'],
    ...(document.technologyId ? { technologyId: document.technologyId } : {}),
    technologyName: document.technologyName,
    status: document.status as StackComponent['status'],
    authority: document.authority as StackComponent['authority'],
    ...(document.selectionSource
      ? { selectionSource: document.selectionSource as StackComponent['selectionSource'] }
      : {}),
    mandatory: document.mandatory,
    version: document.version as unknown as StackComponent['version'],
    evidence: document.evidence as unknown as StackComponent['evidence'],
    evidenceStrength: document.evidenceStrength,
    licence: document.licence,
    costPosture: document.costPosture as StackComponent['costPosture'],
    selfHostable: document.selfHostable,
    ...(document.recommendation
      ? { recommendation: document.recommendation as unknown as StackComponent['recommendation'] }
      : {}),
    riskAcknowledgements:
      document.riskAcknowledgements as unknown as StackComponent['riskAcknowledgements'],
    notes: document.notes,
    ...(document.replacedTechnologyName
      ? { replacedTechnologyName: document.replacedTechnologyName }
      : {}),
    ...(document.replacedReason ? { replacedReason: document.replacedReason } : {}),
    ...(document.lockedAt ? { lockedAt: document.lockedAt.toISOString() } : {}),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export function toSnapshot(
  document: StackSnapshotDocument,
  components: readonly StackComponent[],
): StackSnapshot {
  return {
    id: document.snapshotId,
    projectId: document.projectId,
    version: document.version,
    status: document.status as StackSnapshot['status'],
    selectionMode: document.selectionMode as StackSnapshot['selectionMode'],
    ...(document.baselineId ? { baselineId: document.baselineId } : {}),
    ...(document.baselineVersion ? { baselineVersion: document.baselineVersion } : {}),
    projectTypes: document.projectTypes as StackSnapshot['projectTypes'],
    categoryPlan: document.categoryPlan as unknown as CategoryApplicabilityEntry[],
    components: [...components],
    compatibilityFindings: document.compatibilityFindings as unknown as CompatibilityFinding[],
    highestRisk: document.highestRisk as StackSnapshot['highestRisk'],
    blockers: document.blockers as unknown as StackBlocker[],
    decisions: document.decisions as unknown as StackDecision[],
    ...(document.lastRecommendationRunId
      ? { lastRecommendationRunId: document.lastRecommendationRunId }
      : {}),
    createdAt: document.createdAt.toISOString(),
    ...(document.approvedAt ? { approvedAt: document.approvedAt.toISOString() } : {}),
    ...(document.approvalNote ? { approvalNote: document.approvalNote } : {}),
    ...(document.lockedAt ? { lockedAt: document.lockedAt.toISOString() } : {}),
    ...(document.outdatedAt ? { outdatedAt: document.outdatedAt.toISOString() } : {}),
    ...(document.outdatedReason
      ? { outdatedReason: document.outdatedReason as StackSnapshot['outdatedReason'] }
      : {}),
    ...(document.supersededByVersion ? { supersededByVersion: document.supersededByVersion } : {}),
    updatedAt: document.updatedAt.toISOString(),
    recordVersion: document.recordVersion,
    schemaVersion: document.schemaVersion,
  };
}

export function toRecommendationRun(document: RecommendationRunDocument): RecommendationRun {
  return {
    id: document.runId,
    projectId: document.projectId,
    stackVersion: document.stackVersion,
    baselineVersion: document.baselineVersion,
    projectTypes: [...document.projectTypes],
    categoriesRequested: document.categoriesRequested as RecommendationRun['categoriesRequested'],
    categoriesFilled: document.categoriesFilled as RecommendationRun['categoriesFilled'],
    provider: document.provider,
    model: document.modelName,
    promptVersion: document.promptVersion,
    inputSize: document.inputSize,
    outputSize: document.outputSize,
    durationMs: document.durationMs,
    status: document.status as RecommendationRun['status'],
    retryCount: document.retryCount,
    failures: document.failures as RecommendationRun['failures'],
    executions: document.executions as unknown as RecommendationRun['executions'],
    createdAt: document.createdAt.toISOString(),
    ...(document.completedAt ? { completedAt: document.completedAt.toISOString() } : {}),
  };
}
