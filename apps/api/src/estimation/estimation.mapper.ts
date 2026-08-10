import type { Dependency, EstimateSnapshot, EstimateUnit, EstimationRun } from '@wdrg/contracts';

import type {
  EstimateDependencyDocument,
  EstimateSnapshotDocument,
  EstimateUnitDocument,
  EstimationRunDocument,
} from './schemas/estimation.schema';

/**
 * Stored documents into the shapes the contract describes.
 *
 * One place, so no controller assembles a response by hand and no Mongo
 * internal — `_id`, `__v`, a `Date` — reaches a client by accident.
 */

export function toUnit(document: EstimateUnitDocument): EstimateUnit {
  return {
    id: document.unitId,
    key: document.key,
    requirementIds: [...document.requirementIds],
    module: document.module,
    submodule: document.submodule,
    feature: document.feature,
    taskCategory: document.taskCategory as EstimateUnit['taskCategory'],
    ...(document.overheadActivity
      ? { overheadActivity: document.overheadActivity as EstimateUnit['overheadActivity'] }
      : {}),
    complexity: document.complexity as EstimateUnit['complexity'],
    complexityDrivers: document.complexityDrivers as EstimateUnit['complexityDrivers'],
    complexityExplanation: document.complexityExplanation,
    uncertainty: document.uncertainty as EstimateUnit['uncertainty'],
    uncertaintySources: document.uncertaintySources as EstimateUnit['uncertaintySources'],
    uncertaintyExplanation: document.uncertaintyExplanation,
    effort: document.effort,
    totalHours: document.totalHours,
    range: document.range as unknown as EstimateUnit['range'],
    drivers: document.drivers as unknown as EstimateUnit['drivers'],
    rationale: document.rationale,
    source: document.source as EstimateUnit['source'],
    ...(document.originalEffort ? { originalEffort: document.originalEffort } : {}),
    ...(document.originalTotalHours !== undefined
      ? { originalTotalHours: document.originalTotalHours }
      : {}),
    ...(document.overrideNote ? { overrideNote: document.overrideNote } : {}),
    excluded: document.excluded,
    ...(document.exclusionReason ? { exclusionReason: document.exclusionReason } : {}),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export function toDependency(document: EstimateDependencyDocument): Dependency {
  return {
    id: document.dependencyId,
    predecessorId: document.predecessorId,
    successorId: document.successorId,
    type: document.type as Dependency['type'],
    reason: document.reason as Dependency['reason'],
    lagDays: document.lagDays,
    userDefined: document.userDefined,
    ...(document.note ? { note: document.note } : {}),
  };
}

export function toSnapshot(
  document: EstimateSnapshotDocument,
  estimates: readonly EstimateUnit[],
  dependencies: readonly Dependency[],
): EstimateSnapshot {
  return {
    id: document.snapshotId,
    projectId: document.projectId,
    version: document.version,
    status: document.status as EstimateSnapshot['status'],
    ...(document.baselineId ? { baselineId: document.baselineId } : {}),
    ...(document.baselineVersion ? { baselineVersion: document.baselineVersion } : {}),
    ...(document.stackSnapshotId ? { stackSnapshotId: document.stackSnapshotId } : {}),
    ...(document.stackVersion ? { stackVersion: document.stackVersion } : {}),
    ...(document.timelineDigest ? { timelineDigest: document.timelineDigest } : {}),
    timelineDescription: document.timelineDescription,
    startDateMode: document.startDateMode,
    ...(document.startDate ? { startDate: document.startDate } : {}),
    calendar: document.calendar as unknown as EstimateSnapshot['calendar'],
    team: document.team as unknown as EstimateSnapshot['team'],
    customRoles: document.customRoles as unknown as EstimateSnapshot['customRoles'],
    existingSystem: document.existingSystem as unknown as EstimateSnapshot['existingSystem'],
    integrations: document.integrations as unknown as EstimateSnapshot['integrations'],
    productivityModelVersion: document.productivityModelVersion,
    mentionAiAssistance: document.mentionAiAssistance,
    estimates: [...estimates],
    dependencies: [...dependencies],
    milestones: document.milestones as unknown as EstimateSnapshot['milestones'],
    totalEffort: document.totalEffort as unknown as EstimateSnapshot['totalEffort'],
    effortByRole: document.effortByRole as unknown as EstimateSnapshot['effortByRole'],
    implementationHours: document.implementationHours,
    overheadHours: document.overheadHours,
    schedule: document.schedule as unknown as EstimateSnapshot['schedule'],
    utilisation: document.utilisation as unknown as EstimateSnapshot['utilisation'],
    recommendedStaffing:
      document.recommendedStaffing as unknown as EstimateSnapshot['recommendedStaffing'],
    feasibility: document.feasibility as unknown as EstimateSnapshot['feasibility'],
    blockers: document.blockers as unknown as EstimateSnapshot['blockers'],
    ...(document.riskAcknowledgedAt
      ? { riskAcknowledgedAt: document.riskAcknowledgedAt.toISOString() }
      : {}),
    ...(document.riskAcknowledgementNote
      ? { riskAcknowledgementNote: document.riskAcknowledgementNote }
      : {}),
    ...(document.riskAcknowledgedStatus
      ? { riskAcknowledgedStatus: document.riskAcknowledgedStatus }
      : {}),
    createdAt: document.createdAt.toISOString(),
    ...(document.approvedAt ? { approvedAt: document.approvedAt.toISOString() } : {}),
    ...(document.approvalNote ? { approvalNote: document.approvalNote } : {}),
    ...(document.outdatedAt ? { outdatedAt: document.outdatedAt.toISOString() } : {}),
    ...(document.outdatedReason
      ? { outdatedReason: document.outdatedReason as EstimateSnapshot['outdatedReason'] }
      : {}),
    ...(document.supersededByVersion ? { supersededByVersion: document.supersededByVersion } : {}),
    updatedAt: document.updatedAt.toISOString(),
    recordVersion: document.recordVersion,
    schemaVersion: document.schemaVersion,
  };
}

export function toRun(document: EstimationRunDocument): EstimationRun {
  return {
    id: document.runId,
    projectId: document.projectId,
    estimateVersion: document.estimateVersion,
    baselineVersion: document.baselineVersion,
    stackVersion: document.stackVersion,
    requirementCount: document.requirementCount,
    unitsProduced: document.unitsProduced,
    preservedOverrides: document.preservedOverrides,
    provider: document.provider,
    model: document.modelName,
    promptVersion: document.promptVersion,
    productivityModelVersion: document.productivityModelVersion,
    inputSize: document.inputSize,
    outputSize: document.outputSize,
    durationMs: document.durationMs,
    status: document.status as EstimationRun['status'],
    retryCount: document.retryCount,
    failures: document.failures as EstimationRun['failures'],
    executions: document.executions as unknown as EstimationRun['executions'],
    createdAt: document.createdAt.toISOString(),
    ...(document.completedAt ? { completedAt: document.completedAt.toISOString() } : {}),
  };
}
