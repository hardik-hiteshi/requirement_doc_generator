import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ANALYSIS_LIMITS,
  clarificationKey,
  defaultBlocksApproval,
  evidenceBudgetCharacters,
  type AiTaskExecution,
  type AnalysisFailureReason,
  type ModelProfile,
} from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import { AI_PROVIDER_PORT } from '../../ports';
import { AnalysisRepository } from '../analysis.repository';
import { resolveModelProfile } from '../models/resolve-profile';
import type { InferenceProvider } from '../providers/inference.types';
import { AiTaskRunner, type TaskOutcome } from '../task-runner.service';
import { chunkEvidence, planChunks, type PlannedChunk } from './chunker';
import { EvidenceLoader, type LoadedSource } from './evidence-loader.service';
import { reconcile, type CandidateItem, type ReconciliationResult } from './reconciler';
import {
  ambiguityOutputSchema,
  classifyOutputSchema,
  clarificationOutputSchema,
  conflictsOutputSchema,
  crossSourceOutputSchema,
  duplicatesOutputSchema,
  extractOutputSchema,
  mapModelValue,
  missingOutputSchema,
  normalizeOutputSchema,
  toCategory,
  MODEL_AMBIGUITY_KINDS,
  MODEL_CONFLICT_KINDS,
  MODEL_DUPLICATE_KINDS,
  MODEL_IMPACTS,
  MODEL_MISSING_DIMENSIONS,
  MODEL_PRIORITIES,
  MODEL_QUESTION_CATEGORIES,
  MODEL_SEVERITIES,
} from './task-schemas';
import { baseBlockId } from './chunker';

/**
 * The analysis, from reviewed documents to a draft baseline.
 *
 * Two shapes of work, and the split between them is the whole design.
 *
 * **Per chunk**, independently: normalise the evidence into self-contained
 * statements, classify them, extract structured requirements with citations. A
 * chunk is small enough for a 7B model to hold, and a failure in one costs one
 * chunk rather than the run.
 *
 * **Across all chunks**, once: duplicates, conflicts, ambiguity, gaps,
 * terminology, questions. These are the truths no chunk can see. A requirement
 * stated in file A and contradicted in file B is invisible to both chunks and
 * obvious here — which is exactly why chunking without reconciliation would be
 * a way of *hiding* contradictions rather than a way of fitting a context
 * window.
 *
 * Failure is partial by design. A chunk that fails marks its blocks
 * `not_analysed`, which lowers coverage, adds a blocker and prevents approval.
 * The alternative — failing the whole run — throws away good work; the wrong
 * alternative — carrying on quietly — produces a baseline with a hole in it that
 * nothing records.
 */
@Injectable()
export class AnalysisPipeline {
  constructor(
    private readonly config: AppConfigService,
    private readonly repository: AnalysisRepository,
    private readonly loader: EvidenceLoader,
    private readonly runner: AiTaskRunner,
    @Optional()
    @Inject(AI_PROVIDER_PORT)
    private readonly provider: InferenceProvider | null,
  ) {}

  get isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * Which model this deployment is configured to use.
   *
   * Read before a run starts so the record says what it was trying to use even
   * if it never got as far as using it — the moment that question matters most
   * is when a run failed.
   */
  attribution(): { modelProfileId: string; model: string; provider: string } {
    const profile = resolveModelProfile(this.config);

    return {
      modelProfileId: profile.id,
      model: this.config.ai.modelOverride.trim() || profile.model,
      provider: this.provider?.name ?? 'none',
    };
  }

  /**
   * Runs one analysis to completion, or to an honest failure.
   *
   * Returns everything the caller needs to persist. Nothing is written from
   * here except chunk records and progress — the orchestration service owns the
   * transaction boundary, so a failure mid-pipeline cannot leave half a baseline
   * behind.
   */
  async run(input: PipelineInput): Promise<PipelineResult> {
    const provider = this.provider;

    if (!provider) {
      return failure('provider_unavailable');
    }

    const profile = resolveModelProfile(this.config);
    const model = this.config.ai.modelOverride.trim() || profile.model;
    const executions: AiTaskExecution[] = [];

    const budget = this.evidenceBudget(profile);
    const plan = planChunks(this.loader.toChunkSources(input.sources), {
      budgetCharacters: budget,
      maxChunks: ANALYSIS_LIMITS.maxChunks,
    });

    if (plan.chunks.length === 0) {
      return failure('no_reviewed_sources');
    }

    await input.onChunksPlanned(plan.chunks);

    /* -------------------------------------------------- per-chunk work */

    const candidates: CandidateItem[] = [];
    const nonRequirementBlocks: {
      chunkId: string;
      sourceId: string;
      blockId: string;
      reason: string;
    }[] = [];
    const analysedBlocks: { sourceId: string; blockId: string; chunkId: string }[] = [];
    const unanalysedBlocks: { sourceId: string; blockId: string }[] = [];
    let failedChunks = 0;

    for (const chunk of plan.chunks) {
      if (await input.isCancelled()) {
        return failure('cancelled', executions);
      }

      const chunkId = input.chunkId(chunk.index);
      const outcome = await this.analyseChunk(provider, profile, model, chunk, chunkId, input);

      executions.push(...outcome.executions);

      if (!outcome.ok) {
        failedChunks += 1;

        await this.repository.markChunk(
          input.projectId,
          chunkId,
          'failed',
          outcome.reason ?? 'The model could not analyse this part.',
        );

        // Its blocks become an explicit gap rather than an absence of news.
        for (const blockId of chunk.blockIds) {
          unanalysedBlocks.push({ sourceId: chunk.sourceId, blockId });
        }

        await input.onChunkFinished(chunk.index, false);

        continue;
      }

      candidates.push(...outcome.candidates);
      nonRequirementBlocks.push(...outcome.nonRequirementBlocks);

      for (const blockId of chunk.blockIds) {
        analysedBlocks.push({ sourceId: chunk.sourceId, blockId, chunkId });
      }

      await this.repository.markChunk(input.projectId, chunkId, 'analysed');
      await input.onChunkFinished(chunk.index, true);
    }

    for (const blockId of plan.unplacedBlockIds) {
      const owner = input.sources.find((source) =>
        source.blocks.some((block) => block.id === blockId),
      );

      unanalysedBlocks.push({ sourceId: owner?.sourceId ?? '', blockId });
    }

    if (failedChunks === plan.chunks.length) {
      return failure('all_chunks_failed', executions);
    }

    if (candidates.length > ANALYSIS_LIMITS.maxRequirementItems) {
      return failure('too_many_items', executions);
    }

    /* ------------------------------------------------- reconciliation */

    if (await input.isCancelled()) {
      return failure('cancelled', executions);
    }

    await input.onStage('RECONCILING');

    const reconciled = reconcile({
      candidates,
      nonRequirementBlocks,
      analysedBlocks,
      unanalysedBlocks,
    });

    const global = await this.reconcileGlobally(provider, profile, model, reconciled, input);

    executions.push(...global.executions);

    return {
      ok: true,
      chunks: plan.chunks,
      reconciled,
      duplicates: global.duplicates,
      conflicts: global.conflicts,
      ambiguities: global.ambiguities,
      gaps: global.gaps,
      questions: global.questions,
      executions,
      failedChunks,
      profile,
      model,
      provider: provider.name,
    };
  }

  /* ------------------------------------------------------- chunk stage */

  private async analyseChunk(
    provider: InferenceProvider,
    profile: ModelProfile,
    model: string,
    chunk: PlannedChunk,
    chunkId: string,
    input: PipelineInput,
  ): Promise<ChunkOutcome> {
    const executions: AiTaskExecution[] = [];
    const evidence = chunkEvidence(chunk);
    const knownBlockIds = new Set(evidence.map((entry) => entry.blockId));

    const shared = {
      profile,
      model,
      evidence,
      correlationId: input.correlationId,
      chunkId,
      isCancelled: input.isCancelled,
    };

    const normalized = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.normalize',
      schema: normalizeOutputSchema,
      semantic: {
        validate: (value) =>
          value.statements.flatMap((statement) =>
            statement.blockIds
              .filter((blockId) => !knownBlockIds.has(blockId))
              .map((blockId) => ({
                path: `statements.${statement.id}.blockIds`,
                message: `"${blockId}" is not one of the blocks you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
          ),
      },
    });

    executions.push(normalized.execution);

    if (!normalized.ok) {
      return { ok: false, executions, reason: normalized.reason };
    }

    if (normalized.value.statements.length === 0) {
      // A chunk of headings and page furniture. Legitimately produces nothing,
      // and its blocks are still accounted for as `no_requirement`.
      return {
        ok: true,
        executions,
        candidates: [],
        nonRequirementBlocks: chunk.blockIds.map((blockId) => ({
          chunkId,
          sourceId: chunk.sourceId,
          blockId,
          reason: 'No requirement statements were found in this part of the document.',
        })),
      };
    }

    const priorStatements = JSON.stringify(normalized.value.statements);

    const classified = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.classify',
      priorResults: priorStatements,
      schema: classifyOutputSchema,
    });

    executions.push(classified.execution);

    if (!classified.ok) {
      return { ok: false, executions, reason: classified.reason };
    }

    const extracted = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.extract',
      priorResults: JSON.stringify({
        statements: normalized.value.statements,
        classifications: classified.value.classifications,
      }),
      schema: extractOutputSchema,
      semantic: {
        validate: (value) =>
          value.items.flatMap((item) =>
            item.evidence
              .filter((entry) => !knownBlockIds.has(entry.blockId))
              .map((entry) => ({
                path: `items.${item.id}.evidence`,
                message: `"${entry.blockId}" is not one of the blocks you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
          ),
      },
    });

    executions.push(extracted.execution);

    if (!extracted.ok) {
      return { ok: false, executions, reason: extracted.reason };
    }

    const candidates: CandidateItem[] = extracted.value.items.map((item) => ({
      localId: item.id,
      chunkId,
      sourceId: chunk.sourceId,
      sourceName: chunk.sourceName,
      title: item.title,
      statement: item.description,
      category: toCategory(item.category),
      ...(item.nfrDimension ? { nfrDimension: item.nfrDimension.toLowerCase() } : {}),
      priority: item.priority
        ? mapModelValue(MODEL_PRIORITIES, item.priority, 'priority')
        : 'unspecified',
      modelConfidence: item.confidence,
      evidence: item.evidence.map((entry) => ({
        blockId: baseBlockId(entry.blockId),
        excerpt: entry.excerpt,
      })),
    }));

    return {
      ok: true,
      executions,
      candidates,
      nonRequirementBlocks: extracted.value.nonRequirementBlocks.map((entry) => ({
        chunkId,
        sourceId: chunk.sourceId,
        blockId: baseBlockId(entry.blockId),
        reason: entry.reason,
      })),
    };
  }

  /* -------------------------------------------------- cross-chunk stage */

  /**
   * The stage that makes chunking honest.
   *
   * Every task here sees the whole reconciled set. The evidence it is given is
   * the requirements themselves — not the source documents, which would not fit
   * — so the model compares statements rather than re-reading pages.
   *
   * Each task failing is survivable and is *reported*: a run that could not
   * check for conflicts says so, rather than presenting "no conflicts found".
   */
  private async reconcileGlobally(
    provider: InferenceProvider,
    profile: ModelProfile,
    model: string,
    reconciled: ReconciliationResult,
    input: PipelineInput,
  ): Promise<GlobalOutcome> {
    const executions: AiTaskExecution[] = [];

    const evidence = reconciled.items.map((item) => ({
      blockId: item.key,
      text: `[${item.key}] (${item.category}, from ${item.sourceName}) ${item.title}: ${item.statement}`,
    }));

    const knownKeys = new Set(reconciled.items.map((item) => item.key));
    const shared = {
      profile,
      model,
      evidence,
      correlationId: input.correlationId,
      isCancelled: input.isCancelled,
    };

    const referencesKnownItems = (paths: readonly { path: string; ids: readonly string[] }[]) =>
      paths.flatMap((entry) =>
        entry.ids
          .filter((id) => !knownKeys.has(id))
          .map((id) => ({
            path: entry.path,
            message: `"${id}" is not one of the requirements you were given.`,
            reason: 'hallucinated_source_reference' as const,
          })),
      );

    const duplicates = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.duplicates',
      schema: duplicatesOutputSchema,
      semantic: {
        validate: (value) =>
          referencesKnownItems(
            value.groups.map((group) => ({
              path: `groups.${group.id}.itemIds`,
              ids: [...group.itemIds, group.suggestedPrimaryId],
            })),
          ),
      },
    });

    executions.push(duplicates.execution);

    const conflicts = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.conflicts',
      schema: conflictsOutputSchema,
      semantic: {
        validate: (value) =>
          referencesKnownItems(
            value.conflicts.map((conflict) => ({
              path: `conflicts.${conflict.id}.positions`,
              ids: conflict.positions.map((position) => position.itemId),
            })),
          ),
      },
    });

    executions.push(conflicts.execution);

    const ambiguity = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.ambiguity',
      schema: ambiguityOutputSchema,
      semantic: {
        validate: (value) =>
          referencesKnownItems(
            value.findings.map((finding) => ({
              path: `findings.${finding.id}.itemId`,
              ids: [finding.itemId],
            })),
          ),
      },
    });

    executions.push(ambiguity.execution);

    const missing = await this.runner.run(provider, {
      ...shared,
      taskId: 'requirement.missing',
      schema: missingOutputSchema,
      semantic: {
        validate: (value) =>
          referencesKnownItems(
            value.findings.map((finding) => ({
              path: `findings.${finding.id}.itemId`,
              ids: finding.itemId ? [finding.itemId] : [],
            })),
          ),
      },
    });

    executions.push(missing.execution);

    /*
     * Terminology across documents. Only worth asking when there is more than
     * one document — with a single source there is nothing to be inconsistent
     * with, and spending a minute of local inference to confirm that is waste.
     */
    const sourceCount = new Set(reconciled.items.map((item) => item.sourceId)).size;
    let crossSourceFindings: { term: string; itemIds: string[]; explanation: string }[] = [];

    if (sourceCount > 1) {
      const crossSource = await this.runner.run(provider, {
        ...shared,
        taskId: 'baseline.crossSource',
        schema: crossSourceOutputSchema,
      });

      executions.push(crossSource.execution);

      if (crossSource.ok) {
        crossSourceFindings = crossSource.value.findings.map((finding) => ({
          term: finding.term,
          itemIds: finding.itemIds.filter((id) => knownKeys.has(id)),
          explanation: finding.usages
            .map((usage) => `${usage.sourceId}: ${usage.meaning}`)
            .join(' · '),
        }));
      }
    }

    const questions = await this.runner.run(provider, {
      ...shared,
      taskId: 'clarification.generate',
      priorResults: JSON.stringify({
        conflicts: conflicts.ok ? conflicts.value.conflicts : [],
        ambiguities: ambiguity.ok ? ambiguity.value.findings : [],
        gaps: missing.ok ? missing.value.findings : [],
      }),
      schema: clarificationOutputSchema,
      semantic: {
        validate: (value) =>
          referencesKnownItems(
            value.questions.map((question) => ({
              path: `questions.${question.id}.itemIds`,
              ids: question.itemIds,
            })),
          ),
      },
    });

    executions.push(questions.execution);

    return {
      executions,
      duplicates: mergeDuplicates(reconciled, duplicates),
      conflicts: mapConflicts(reconciled, conflicts, crossSourceFindings),
      ambiguities: mapAmbiguities(ambiguity),
      gaps: mapGaps(missing),
      questions: mapQuestions(questions),
    };
  }

  private evidenceBudget(profile: ModelProfile): number {
    const context =
      this.config.ai.maxContextTokens > 0
        ? Math.min(this.config.ai.maxContextTokens, profile.contextTokens)
        : profile.contextTokens;
    const output =
      this.config.ai.maxOutputTokens > 0
        ? Math.min(this.config.ai.maxOutputTokens, profile.maxOutputTokens)
        : profile.maxOutputTokens;

    return evidenceBudgetCharacters(context, output);
  }
}

/* ------------------------------------------------------------- mapping */

/**
 * The model's restated duplicates, plus the ones computed deterministically.
 *
 * Both sources are kept, and the deterministic ones win where they overlap: an
 * exact textual match is a fact, and a model's opinion that the same pair is
 * "restated" adds nothing to it.
 */
function mergeDuplicates(
  reconciled: ReconciliationResult,
  outcome: TaskOutcome<{
    groups: {
      id: string;
      itemIds: string[];
      kind: string;
      explanation: string;
      suggestedPrimaryId: string;
    }[];
  }>,
): MappedDuplicate[] {
  const byKey = new Map(reconciled.items.map((item) => [item.key, item]));
  const claimed = new Set<string>();
  const groups: MappedDuplicate[] = [];

  for (const deterministic of reconciled.duplicates) {
    for (const key of deterministic.keys) {
      claimed.add(key);
    }

    groups.push({
      keys: [...deterministic.keys],
      kind: deterministic.kind,
      similarity: deterministic.similarity,
      rationale: deterministic.rationale,
      crossChunk: deterministic.crossChunk,
      crossSource: deterministic.crossSource,
      suggestedPrimaryKey: bestEvidenced(deterministic.keys, byKey),
    });
  }

  if (!outcome.ok) {
    return groups;
  }

  for (const group of outcome.value.groups) {
    const keys = group.itemIds.filter((key) => byKey.has(key) && !claimed.has(key));

    if (keys.length < 2) {
      continue;
    }

    for (const key of keys) {
      claimed.add(key);
    }

    const members = keys.flatMap((key) => {
      const item = byKey.get(key);

      return item ? [item] : [];
    });

    groups.push({
      keys,
      kind: mapModelValue(MODEL_DUPLICATE_KINDS, group.kind, 'duplicate kind'),
      similarity: 0,
      rationale: group.explanation,
      crossChunk: new Set(members.map((item) => item.chunkId)).size > 1,
      crossSource: new Set(members.map((item) => item.sourceId)).size > 1,
      suggestedPrimaryKey: keys.includes(group.suggestedPrimaryId)
        ? group.suggestedPrimaryId
        : bestEvidenced(keys, byKey),
    });
  }

  return groups;
}

/** The member with the most citations. A tiebreak, not a decision. */
function bestEvidenced(
  keys: readonly string[],
  byKey: ReadonlyMap<string, { key: string; evidence: readonly unknown[] }>,
): string {
  let best = keys[0] ?? '';
  let bestCount = -1;

  for (const key of keys) {
    const count = byKey.get(key)?.evidence.length ?? 0;

    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }

  return best;
}

function mapConflicts(
  reconciled: ReconciliationResult,
  outcome: TaskOutcome<{
    conflicts: {
      id: string;
      kind: string;
      severity: string;
      summary: string;
      positions: { itemId: string; statement: string }[];
    }[];
  }>,
  crossSourceFindings: readonly { term: string; itemIds: string[]; explanation: string }[],
): MappedConflict[] {
  const byKey = new Map(reconciled.items.map((item) => [item.key, item]));
  const conflicts: MappedConflict[] = [];

  if (outcome.ok) {
    for (const conflict of outcome.value.conflicts) {
      const positions = conflict.positions.flatMap((position) => {
        const item = byKey.get(position.itemId);

        return item
          ? [
              {
                itemKey: item.key,
                statement: position.statement,
                sourceId: item.sourceId,
                sourceName: item.sourceName,
              },
            ]
          : [];
      });

      if (positions.length < 2) {
        continue;
      }

      conflicts.push({
        keys: positions.map((position) => position.itemKey),
        kind: mapModelValue(MODEL_CONFLICT_KINDS, conflict.kind, 'conflict kind'),
        severity: mapModelValue(MODEL_SEVERITIES, conflict.severity, 'severity'),
        summary: conflict.summary,
        positions,
        crossChunk:
          new Set(positions.map((position) => byKey.get(position.itemKey)?.chunkId)).size > 1,
        crossSource: new Set(positions.map((position) => position.sourceId)).size > 1,
      });
    }
  }

  /*
   * A term used two ways across documents is a conflict, not a note. Left as a
   * remark it gets read past; as a `terminology` conflict it appears in the
   * same list as the contradictions and has to be decided about.
   */
  for (const finding of crossSourceFindings) {
    const positions = finding.itemIds.flatMap((key) => {
      const item = byKey.get(key);

      return item
        ? [
            {
              itemKey: item.key,
              statement: item.statement,
              sourceId: item.sourceId,
              sourceName: item.sourceName,
            },
          ]
        : [];
    });

    if (positions.length < 2 || new Set(positions.map((p) => p.sourceId)).size < 2) {
      continue;
    }

    conflicts.push({
      keys: positions.map((position) => position.itemKey),
      kind: 'terminology',
      severity: 'major',
      summary: `"${finding.term}" is used differently in different documents. ${finding.explanation}`,
      positions,
      crossChunk: true,
      crossSource: true,
    });
  }

  return conflicts;
}

function mapAmbiguities(
  outcome: TaskOutcome<{
    findings: {
      id: string;
      itemId: string;
      kind: string;
      phrase: string;
      whyNotImplementable: string;
      suggestion?: string | null;
    }[];
  }>,
): MappedAmbiguity[] {
  if (!outcome.ok) {
    return [];
  }

  return outcome.value.findings.map((finding) => ({
    itemKey: finding.itemId,
    kind: mapModelValue(MODEL_AMBIGUITY_KINDS, finding.kind, 'ambiguity kind'),
    phrase: finding.phrase,
    why: finding.whyNotImplementable,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
  }));
}

function mapGaps(
  outcome: TaskOutcome<{
    findings: {
      id: string;
      itemId?: string | null;
      dimension: string;
      whyItMatters: string;
      blocking: boolean;
    }[];
  }>,
): MappedGap[] {
  if (!outcome.ok) {
    return [];
  }

  return outcome.value.findings.map((finding) => ({
    ...(finding.itemId ? { itemKey: finding.itemId } : {}),
    dimension: mapModelValue(MODEL_MISSING_DIMENSIONS, finding.dimension, 'dimension'),
    why: finding.whyItMatters,
    blocksImplementation: finding.blocking,
  }));
}

function mapQuestions(
  outcome: TaskOutcome<{
    questions: {
      id: string;
      question: string;
      reason: string;
      category: string;
      impact: string;
      itemIds: string[];
    }[];
  }>,
): MappedQuestion[] {
  if (!outcome.ok) {
    return [];
  }

  return outcome.value.questions.map((question, index) => {
    const category = mapModelValue(MODEL_QUESTION_CATEGORIES, question.category, 'category');
    const impact = mapModelValue(MODEL_IMPACTS, question.impact, 'impact');

    return {
      key: clarificationKey(index + 1),
      question: question.question,
      rationale: question.reason,
      category,
      impact,
      itemKeys: question.itemIds,
      blocksApproval: defaultBlocksApproval(category, impact),
    };
  });
}

function failure(
  reason: AnalysisFailureReason,
  executions: readonly AiTaskExecution[] = [],
): PipelineResult {
  return { ok: false, reason, executions: [...executions] };
}

/* --------------------------------------------------------------- types */

export interface PipelineInput {
  readonly projectId: string;
  readonly correlationId: string;
  readonly sources: readonly LoadedSource[];
  readonly chunkId: (index: number) => string;
  readonly isCancelled: () => Promise<boolean>;
  readonly onChunksPlanned: (chunks: readonly PlannedChunk[]) => Promise<void>;
  readonly onChunkFinished: (index: number, succeeded: boolean) => Promise<void>;
  readonly onStage: (stage: 'RECONCILING' | 'FINALISING') => Promise<void>;
}

export interface MappedDuplicate {
  readonly keys: string[];
  readonly kind: 'exact' | 'near' | 'restated';
  readonly similarity: number;
  readonly rationale: string;
  readonly crossChunk: boolean;
  readonly crossSource: boolean;
  readonly suggestedPrimaryKey: string;
}

export interface MappedConflict {
  readonly keys: string[];
  readonly kind: string;
  readonly severity: 'blocking' | 'major' | 'minor';
  readonly summary: string;
  readonly positions: {
    itemKey: string;
    statement: string;
    sourceId: string;
    sourceName: string;
  }[];
  readonly crossChunk: boolean;
  readonly crossSource: boolean;
}

export interface MappedAmbiguity {
  readonly itemKey: string;
  readonly kind: string;
  readonly phrase: string;
  readonly why: string;
  readonly suggestion?: string;
}

export interface MappedGap {
  readonly itemKey?: string;
  readonly dimension: string;
  readonly why: string;
  readonly blocksImplementation: boolean;
}

export interface MappedQuestion {
  readonly key: string;
  readonly question: string;
  readonly rationale: string;
  readonly category: string;
  readonly impact: string;
  readonly itemKeys: string[];
  readonly blocksApproval: boolean;
}

type ChunkOutcome =
  | {
      readonly ok: true;
      readonly executions: AiTaskExecution[];
      readonly candidates: CandidateItem[];
      readonly nonRequirementBlocks: {
        chunkId: string;
        sourceId: string;
        blockId: string;
        reason: string;
      }[];
    }
  | { readonly ok: false; readonly executions: AiTaskExecution[]; readonly reason?: string };

interface GlobalOutcome {
  readonly executions: AiTaskExecution[];
  readonly duplicates: MappedDuplicate[];
  readonly conflicts: MappedConflict[];
  readonly ambiguities: MappedAmbiguity[];
  readonly gaps: MappedGap[];
  readonly questions: MappedQuestion[];
}

export type PipelineResult =
  | {
      readonly ok: true;
      readonly chunks: readonly PlannedChunk[];
      readonly reconciled: ReconciliationResult;
      readonly duplicates: MappedDuplicate[];
      readonly conflicts: MappedConflict[];
      readonly ambiguities: MappedAmbiguity[];
      readonly gaps: MappedGap[];
      readonly questions: MappedQuestion[];
      readonly executions: AiTaskExecution[];
      readonly failedChunks: number;
      readonly profile: ModelProfile;
      readonly model: string;
      readonly provider: string;
    }
  | {
      readonly ok: false;
      readonly reason: AnalysisFailureReason;
      readonly executions: AiTaskExecution[];
    };
