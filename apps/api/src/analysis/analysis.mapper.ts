import type {
  AmbiguityFinding,
  AnalysisRun,
  Clarification,
  Conflict,
  DuplicateGroup,
  MissingInfoFinding,
  RequirementItem,
} from '@wdrg/contracts';

import type {
  AnalysisFindingDocument,
  AnalysisRunDocument,
  ClarificationDocument,
  RequirementItemDocument,
} from './schemas/analysis.schema';

/**
 * Stored documents into the shapes the contracts describe.
 *
 * A boundary rather than a formality. Mongo documents carry `_id`, timestamps,
 * a schema version and a payload envelope that findings share between four
 * kinds; none of that belongs in an API response or in the calculations. Going
 * through explicit mappers means adding a field to a collection does not
 * silently add it to what the browser receives.
 */

export function toItem(document: RequirementItemDocument): RequirementItem {
  return {
    id: document.itemId,
    projectId: document.projectId,
    runId: document.runId,
    key: document.key,
    title: document.title,
    statement: document.statement,
    category: document.category as RequirementItem['category'],
    ...(document.nfrDimension
      ? { nfrDimension: document.nfrDimension as RequirementItem['nfrDimension'] }
      : {}),
    priority: document.priority as RequirementItem['priority'],
    references: document.references as unknown as RequirementItem['references'],
    ...(document.modelConfidence
      ? {
          modelConfidence:
            document.modelConfidence as unknown as RequirementItem['modelConfidence'],
        }
      : {}),
    evidenceConfidence:
      document.evidenceConfidence as unknown as RequirementItem['evidenceConfidence'],
    origin: document.origin as RequirementItem['origin'],
    status: document.status as RequirementItem['status'],
    editedByUser: document.editedByUser,
    chunkIds: document.chunkIds,
    ...(document.supersededById ? { supersededById: document.supersededById } : {}),
    ...(document.proposedRevision
      ? {
          proposedRevision:
            document.proposedRevision as unknown as RequirementItem['proposedRevision'],
        }
      : {}),
    needsRevalidation: document.needsRevalidation ?? false,
    createdAt: timestamp(document, 'createdAt'),
    updatedAt: timestamp(document, 'updatedAt'),
    version: document.version,
  };
}

export function toDuplicate(document: AnalysisFindingDocument): DuplicateGroup {
  const payload = document.payload as {
    suggestedPrimaryId: string;
    similarity: number;
    rationale: string;
    crossChunk: boolean;
    crossSource: boolean;
  };

  return {
    id: document.findingId,
    projectId: document.projectId,
    runId: document.runId,
    kind: (document.kind ?? 'near') as DuplicateGroup['kind'],
    itemIds: document.itemIds,
    suggestedPrimaryId: payload.suggestedPrimaryId,
    similarity: payload.similarity,
    rationale: payload.rationale,
    crossChunk: payload.crossChunk,
    crossSource: payload.crossSource,
    status: document.status as DuplicateGroup['status'],
    ...(document.resolution
      ? { resolution: document.resolution as unknown as DuplicateGroup['resolution'] }
      : {}),
    createdAt: timestamp(document, 'createdAt'),
    version: document.version,
  };
}

export function toConflict(document: AnalysisFindingDocument): Conflict {
  const payload = document.payload as {
    summary: string;
    positions: Conflict['positions'];
    crossChunk: boolean;
    crossSource: boolean;
  };

  return {
    id: document.findingId,
    projectId: document.projectId,
    runId: document.runId,
    kind: (document.kind ?? 'contradiction') as Conflict['kind'],
    severity: (document.severity ?? 'major') as Conflict['severity'],
    itemIds: document.itemIds,
    summary: payload.summary,
    positions: payload.positions,
    crossChunk: payload.crossChunk,
    crossSource: payload.crossSource,
    status: document.status as Conflict['status'],
    reevaluations: (document.reevaluations ?? []) as unknown as Conflict['reevaluations'],
    ...(document.resolution
      ? { resolution: document.resolution as unknown as Conflict['resolution'] }
      : {}),
    createdAt: timestamp(document, 'createdAt'),
    version: document.version,
  };
}

export function toAmbiguity(document: AnalysisFindingDocument): AmbiguityFinding {
  const payload = document.payload as { phrase: string; why: string; suggestion?: string };

  return {
    id: document.findingId,
    projectId: document.projectId,
    runId: document.runId,
    itemId: document.itemIds[0] ?? '',
    kind: (document.kind ?? 'vague_term') as AmbiguityFinding['kind'],
    phrase: payload.phrase,
    why: payload.why,
    ...(payload.suggestion ? { suggestion: payload.suggestion } : {}),
    status: document.status as AmbiguityFinding['status'],
    ...(document.resolution
      ? { decision: document.resolution as unknown as AmbiguityFinding['decision'] }
      : {}),
    createdAt: timestamp(document, 'createdAt'),
    version: document.version,
  };
}

export function toGap(document: AnalysisFindingDocument): MissingInfoFinding {
  const payload = document.payload as { why: string };

  return {
    id: document.findingId,
    projectId: document.projectId,
    runId: document.runId,
    ...(document.itemIds[0] ? { itemId: document.itemIds[0] } : {}),
    dimension: (document.kind ?? 'acceptance_criteria') as MissingInfoFinding['dimension'],
    why: payload.why,
    blocksImplementation: document.blocking,
    status: document.status as MissingInfoFinding['status'],
    ...(document.resolution
      ? { decision: document.resolution as unknown as MissingInfoFinding['decision'] }
      : {}),
    createdAt: timestamp(document, 'createdAt'),
    version: document.version,
  };
}

export function toClarification(document: ClarificationDocument): Clarification {
  return {
    id: document.clarificationId,
    projectId: document.projectId,
    runId: document.runId,
    key: document.key,
    question: document.question,
    rationale: document.rationale,
    category: document.category as Clarification['category'],
    impact: document.impact as Clarification['impact'],
    ...(document.dimension ? { dimension: document.dimension as Clarification['dimension'] } : {}),
    relatedItemIds: document.relatedItemIds,
    relatedConflictIds: document.relatedConflictIds,
    relatedFindingIds: document.relatedFindingIds,
    status: document.status as Clarification['status'],
    answers: (document.answers ?? []) as unknown as Clarification['answers'],
    ...(document.dismissal
      ? { dismissal: document.dismissal as unknown as Clarification['dismissal'] }
      : {}),
    blocksApproval: document.blocksApproval,
    createdAt: timestamp(document, 'createdAt'),
    updatedAt: timestamp(document, 'updatedAt'),
    version: document.version,
  };
}

export function toRun(document: AnalysisRunDocument): AnalysisRun {
  return {
    id: document.runId,
    projectId: document.projectId,
    sequence: document.sequence,
    status: document.status as AnalysisRun['status'],
    sourceIds: document.sourceIds,
    contentDigest: document.contentDigest,
    progress: document.progress as unknown as AnalysisRun['progress'],
    executions: document.executions as unknown as AnalysisRun['executions'],
    modelProfileId: document.modelProfileId,
    model: document.modelName,
    provider: document.provider,
    promptRegistryChecksum: document.promptRegistryChecksum,
    ...(document.failureReason
      ? { failureReason: document.failureReason as AnalysisRun['failureReason'] }
      : {}),
    ...(document.baselineId ? { baselineId: document.baselineId } : {}),
    startedAt: document.startedAt.toISOString(),
    ...(document.completedAt ? { completedAt: document.completedAt.toISOString() } : {}),
    ...(document.cancellationRequestedAt
      ? { cancellationRequestedAt: document.cancellationRequestedAt.toISOString() }
      : {}),
    version: document.version,
  };
}

function timestamp(document: object, field: 'createdAt' | 'updatedAt'): string {
  const value = (document as Record<string, unknown>)[field];

  return value instanceof Date ? value.toISOString() : new Date().toISOString();
}
