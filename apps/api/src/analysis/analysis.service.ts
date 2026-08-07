import { Injectable, Logger } from '@nestjs/common';
import {
  ANALYSIS_ERROR_CODES,
  ANALYSIS_LIMITS,
  BASELINE_AI_NOTICE,
  canApprove,
  clarificationKey,
  DISPOSITIONS_REQUIRING_REFERENCE,
  requirementKey,
  type AnalysisRun,
  type AnswerClarification,
  type ApproveBaseline,
  type Baseline,
  type Clarification,
  type ClarificationAnswer,
  type ConflictVersion,
  type DismissClarification,
  type IntegrationResult,
  type ManualRequirement,
  type ProposedRevision,
  type ResolveProposal,
  type RequirementItem,
  type RequirementItemEdit,
  type RequirementVersion,
  type ResolveConflict,
  type ResolveDuplicate,
  type ResolveFinding,
  type StartAnalysis,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { AnalysisRepository } from './analysis.repository';
import { ClarificationIntegration } from './clarification-integration.service';
import { ConflictReevaluator, reevaluationInputFrom } from './conflict-reevaluation.service';
import { clarificationLink } from './pipeline/evidence.service';
import type { ClarificationDocument } from './schemas/analysis.schema';
import { AnalysisError } from './analysis.errors';
import {
  toAmbiguity,
  toClarification,
  toConflict,
  toDuplicate,
  toGap,
  toItem,
  toRun,
} from './analysis.mapper';
import { BaselineService, countByCategory, toBaseline } from './baseline.service';
import { promptRegistryChecksum } from './prompts/prompt-registry';
import { AnalysisPipeline, type PipelineResult } from './pipeline/analysis-pipeline.service';
import { EvidenceLoader } from './pipeline/evidence-loader.service';
import { EvidenceService } from './pipeline/evidence.service';

export interface AnalysisContext {
  readonly projectId: string;
  readonly correlationId: string;
}

/**
 * The Phase 4 workflow, from "analyse my documents" to an approved baseline.
 *
 * Four commitments run through every method here, and each exists because
 * breaking it produces a document a client would be wrong to trust.
 *
 * **Nothing is decided for the user.** Duplicates are grouped and not merged;
 * conflicts are surfaced with both sides and no winner; gaps are reported and
 * never filled with a plausible value. Every one of those actions destroys
 * information that only a person can supply.
 *
 * **A person's decision outranks the model's, permanently.** Re-analysis
 * carries edits and acceptances forward and presents new output as a proposal.
 * `editedByUser` is set once and never cleared.
 *
 * **Derived numbers are recomputed, never patched.** Coverage, alignment and
 * blockers come from stored records every time anything changes.
 *
 * **Failure is partial and visible.** A chunk that fails lowers coverage, adds
 * a blocker and prevents approval, rather than either failing the whole run or
 * quietly producing a baseline with a hole in it.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  /** Runs in flight in this process, so a cancel does not have to wait on a poll. */
  private readonly running = new Set<string>();

  constructor(
    private readonly repository: AnalysisRepository,
    private readonly pipeline: AnalysisPipeline,
    private readonly loader: EvidenceLoader,
    private readonly evidence: EvidenceService,
    private readonly baselines: BaselineService,
    private readonly integration: ClarificationIntegration,
    private readonly conflicts: ConflictReevaluator,
    private readonly audit: AuditService,
  ) {}

  /* --------------------------------------------------------------- runs */

  /**
   * Starts an analysis.
   *
   * Returns as soon as the run record exists; the work continues in the
   * background. A synchronous call would hold an HTTP connection open for the
   * minutes a local model takes on CPU, and the progress endpoint exists
   * precisely so the browser does not have to.
   */
  async start(context: AnalysisContext, request: StartAnalysis): Promise<AnalysisRun> {
    if (!this.pipeline.isConfigured) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.ANALYSIS_NOT_CONFIGURED, 503);
    }

    const active = await this.repository.activeRun(context.projectId);

    if (active) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.ANALYSIS_ALREADY_RUNNING, 409);
    }

    const sources = await this.loader.loadReviewed(context.projectId);

    if (sources.length === 0) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.NO_REVIEWED_SOURCES, 422);
    }

    const runId = AnalysisRepository.newId('run');
    const sequence = await this.repository.nextRunSequence(context.projectId);
    /*
     * Recorded at the start, not at the end. Which model a run used is
     * configuration, so it is knowable before any inference happens — and a run
     * that fails half-way still has to say what it was trying to use, which is
     * exactly when that question gets asked.
     */
    const attribution = this.pipeline.attribution();

    const record = await this.repository.createRun({
      runId,
      projectId: context.projectId,
      sequence,
      status: 'PENDING',
      sourceIds: sources.map((source) => source.sourceId),
      contentDigest: this.loader.digest(sources),
      progress: { totalChunks: 0, analysedChunks: 0, failedChunks: 0 },
      executions: [],
      modelProfileId: attribution.modelProfileId,
      modelName: attribution.model,
      provider: attribution.provider,
      promptRegistryChecksum: promptRegistryChecksum(),
      startedAt: new Date(),
    });

    await this.audit.record({
      type: 'ANALYSIS_STARTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      // Counts only. What the documents say is requirement evidence, and an
      // audit document must be safe to read and to ship.
      metadata: {
        runId,
        sequence,
        sourceCount: sources.length,
        preserveUserDecisions: request.preserveUserDecisions,
      },
    });

    void this.execute(context, runId, request).catch((cause: unknown) => {
      this.logger.error(
        { runId, correlationId: context.correlationId },
        'Analysis run failed outside the pipeline',
      );

      void this.fail(context, runId, 'internal_error', cause);
    });

    return toRun(record);
  }

  /** Runs the pipeline and persists everything it produced. */
  private async execute(
    context: AnalysisContext,
    runId: string,
    request: StartAnalysis,
  ): Promise<void> {
    this.running.add(runId);

    try {
      const sources = await this.loader.loadReviewed(context.projectId);

      await this.repository.updateRun(context.projectId, runId, { status: 'CHUNKING' });

      const result = await this.pipeline.run({
        projectId: context.projectId,
        correlationId: context.correlationId,
        sources,
        chunkId: (index) => `${runId}-c${String(index).padStart(4, '0')}`,
        isCancelled: () => this.repository.isCancelled(context.projectId, runId),
        onChunksPlanned: async (chunks) => {
          await this.repository.insertChunks(
            chunks.map((chunk) => ({
              chunkId: `${runId}-c${String(chunk.index).padStart(4, '0')}`,
              runId,
              projectId: context.projectId,
              index: chunk.index,
              sourceId: chunk.sourceId,
              sourceName: chunk.sourceName,
              blockIds: [...chunk.blockIds],
              blockParts: chunk.blockParts.map((part) => ({ ...part })),
              characterCount: chunk.characterCount,
              estimatedTokens: chunk.estimatedTokens,
              boundary: chunk.boundary,
              ...(chunk.heading ? { heading: chunk.heading } : {}),
              status: 'pending',
            })),
          );

          await this.repository.updateRun(context.projectId, runId, {
            status: 'ANALYSING',
            progress: { totalChunks: chunks.length, analysedChunks: 0, failedChunks: 0 },
          });
        },
        onChunkFinished: async (index, succeeded) => {
          const run = await this.repository.findRun(context.projectId, runId);
          const progress = (run?.progress ?? {}) as {
            totalChunks?: number;
            analysedChunks?: number;
            failedChunks?: number;
          };

          await this.repository.updateRun(context.projectId, runId, {
            progress: {
              totalChunks: progress.totalChunks ?? 0,
              analysedChunks: (progress.analysedChunks ?? 0) + (succeeded ? 1 : 0),
              failedChunks: (progress.failedChunks ?? 0) + (succeeded ? 0 : 1),
              currentChunkIndex: index,
            },
          });
        },
        onStage: async (stage) => {
          await this.repository.updateRun(context.projectId, runId, { status: stage });
        },
      });

      if (!result.ok) {
        await this.repository.appendExecutions(context.projectId, runId, result.executions);

        await this.fail(context, runId, result.reason);

        return;
      }

      await this.repository.updateRun(context.projectId, runId, { status: 'FINALISING' });

      await this.persist(context, runId, result, request);
    } finally {
      this.running.delete(runId);
    }
  }

  /**
   * Writes everything the pipeline produced, then builds the baseline.
   *
   * Order matters: requirements first, because everything else refers to them
   * by key and needs the ids those keys resolve to.
   */
  private async persist(
    context: AnalysisContext,
    runId: string,
    result: Extract<PipelineResult, { ok: true }>,
    request: StartAnalysis,
  ): Promise<void> {
    const now = new Date();
    const evidenceContext = await this.loader.buildContext(context.projectId);
    const previous = request.preserveUserDecisions
      ? await this.repository.listItems(context.projectId)
      : [];
    const decided = new Map(
      previous
        .filter((item) => item.editedByUser || item.status === 'accepted')
        .map((item) => [normalizeKey(item.statement), item]),
    );

    const idByKey = new Map<string, string>();
    const items: Record<string, unknown>[] = [];
    let sequence = 1;

    for (const candidate of result.reconciled.items) {
      const itemId = AnalysisRepository.newId('req');
      const references = this.evidence.resolveReferences(
        candidate.evidence,
        candidate.sourceId,
        evidenceContext,
      );

      /*
       * A requirement a person already edited or accepted, produced again by a
       * later run. The human wording wins and `editedByUser` stays set — the
       * new run may have found better evidence, and that is worth taking, but
       * it does not get to rewrite a sentence somebody chose.
       */
      const carried = decided.get(normalizeKey(candidate.statement));

      const score = this.evidence.score(
        references,
        evidenceContext,
        {
          clarificationKeys: [],
          humanReviewed: carried !== undefined,
          inOpenConflict: result.conflicts.some((conflict) =>
            conflict.keys.includes(candidate.key),
          ),
          hasOpenAmbiguity: result.ambiguities.some(
            (ambiguity) => ambiguity.itemKey === candidate.key,
          ),
        },
        now,
      );

      idByKey.set(candidate.key, itemId);

      items.push({
        itemId,
        projectId: context.projectId,
        runId,
        key: requirementKey(sequence),
        title: carried?.title ?? candidate.title,
        statement: carried?.statement ?? candidate.statement,
        category: carried?.category ?? candidate.category,
        ...(candidate.nfrDimension ? { nfrDimension: candidate.nfrDimension } : {}),
        priority: carried?.priority ?? candidate.priority,
        references: references,
        modelConfidence: { value: candidate.modelConfidence },
        evidenceConfidence: score,
        origin: 'ai',
        status: carried ? carried.status : 'draft',
        editedByUser: carried?.editedByUser ?? false,
        chunkIds: [...candidate.chunkIds],
        version: 0,
      });

      sequence += 1;
    }

    await this.repository.insertItems(items);

    const resolve = (keys: readonly string[]): string[] =>
      keys.flatMap((key) => {
        const id = idByKey.get(key);

        return id ? [id] : [];
      });

    const findings: Record<string, unknown>[] = [];

    for (const duplicate of result.duplicates) {
      const itemIds = resolve(duplicate.keys);

      if (itemIds.length < 2) {
        continue;
      }

      findings.push({
        findingId: AnalysisRepository.newId('dup'),
        projectId: context.projectId,
        runId,
        type: 'duplicate',
        status: 'open',
        itemIds,
        blocking: false,
        kind: duplicate.kind,
        payload: {
          suggestedPrimaryId: idByKey.get(duplicate.suggestedPrimaryKey) ?? itemIds[0],
          similarity: duplicate.similarity,
          rationale: duplicate.rationale,
          crossChunk: duplicate.crossChunk,
          crossSource: duplicate.crossSource,
        },
        version: 0,
      });
    }

    for (const conflict of result.conflicts) {
      const itemIds = resolve(conflict.keys);

      if (itemIds.length < 2) {
        continue;
      }

      findings.push({
        findingId: AnalysisRepository.newId('con'),
        projectId: context.projectId,
        runId,
        type: 'conflict',
        status: 'open',
        itemIds,
        blocking: conflict.severity === 'blocking',
        kind: conflict.kind,
        severity: conflict.severity,
        reevaluations: [],
        payload: {
          summary: conflict.summary,
          positions: conflict.positions.map((position) => ({
            itemId: idByKey.get(position.itemKey) ?? '',
            statement: position.statement,
            sourceId: position.sourceId,
            sourceName: position.sourceName,
          })),
          crossChunk: conflict.crossChunk,
          crossSource: conflict.crossSource,
        },
        version: 0,
      });
    }

    for (const ambiguity of result.ambiguities) {
      const itemId = idByKey.get(ambiguity.itemKey);

      if (!itemId) {
        continue;
      }

      findings.push({
        findingId: AnalysisRepository.newId('amb'),
        projectId: context.projectId,
        runId,
        type: 'ambiguity',
        status: 'open',
        itemIds: [itemId],
        blocking: false,
        kind: ambiguity.kind,
        payload: {
          phrase: ambiguity.phrase,
          why: ambiguity.why,
          ...(ambiguity.suggestion ? { suggestion: ambiguity.suggestion } : {}),
        },
        version: 0,
      });
    }

    for (const gap of result.gaps) {
      const itemId = gap.itemKey ? idByKey.get(gap.itemKey) : undefined;

      findings.push({
        findingId: AnalysisRepository.newId('gap'),
        projectId: context.projectId,
        runId,
        type: 'missing',
        status: 'open',
        itemIds: itemId ? [itemId] : [],
        blocking: gap.blocksImplementation,
        kind: gap.dimension,
        payload: { why: gap.why },
        version: 0,
      });
    }

    await this.repository.insertFindings(findings);

    /*
     * The original positions, snapshotted the moment the conflict exists.
     *
     * Later changes each record what came before them, so this would eventually
     * be captured anyway — but only if something changes. Writing it now means
     * "what was originally conflicting?" is answerable even for a conflict that
     * is resolved on its first touch.
     */
    for (const finding of findings.filter((entry) => entry.type === 'conflict')) {
      const payload = finding.payload as {
        summary?: string;
        positions?: Record<string, unknown>[];
      };

      await this.repository.recordConflictVersion({
        conflictId: finding.findingId as string,
        projectId: context.projectId,
        version: 0,
        status: 'open',
        severity: (finding.severity as string) ?? 'major',
        kind: (finding.kind as string) ?? 'contradiction',
        summary: payload.summary ?? '',
        itemIds: [...((finding.itemIds as string[]) ?? [])],
        positions: payload.positions ?? [],
        changedBy: 'analysis',
        recordedAt: now,
      });
    }

    const clarifications = result.questions.map((question, index) => ({
      clarificationId: AnalysisRepository.newId('clr'),
      projectId: context.projectId,
      runId,
      key: clarificationKey(index + 1),
      question: question.question,
      rationale: question.rationale,
      category: question.category,
      impact: question.impact,
      relatedItemIds: resolve(question.itemKeys),
      relatedConflictIds: [],
      relatedFindingIds: [],
      status: 'UNANSWERED',
      answers: [],
      blocksApproval: question.blocksApproval,
      version: 0,
    }));

    await this.repository.insertClarifications(clarifications);

    /* --------------------------------------------------------- baseline */

    const dispositions = result.reconciled.dispositions.map((record) => ({
      ...record,
      itemIds: record.itemIds.flatMap((key) => {
        const id = idByKey.get(key);

        return id ? [id] : [];
      }),
    }));

    const version = await this.repository.nextBaselineVersion(context.projectId);
    const baselineId = AnalysisRepository.newId('bas');
    const run = await this.repository.findRun(context.projectId, runId);

    await this.repository.createBaseline({
      baselineId,
      projectId: context.projectId,
      runId,
      version,
      status: 'draft',
      itemIds: items.map((item) => item.itemId as string),
      itemCount: items.length,
      categoryCounts: countByCategory(items.map((item) => item as unknown as RequirementItem)),
      coverage: {},
      alignment: {},
      blockers: [],
      dispositions: dispositions,
      contentDigest: run?.contentDigest ?? '',
      recordVersion: 0,
    });

    await this.repository.supersedeBaselines(context.projectId, version);
    await this.repository.supersedeRuns(context.projectId, runId);
    await this.repository.appendExecutions(context.projectId, runId, result.executions);

    // Everything derived, computed from what was just written rather than
    // accumulated while writing it.
    await this.baselines.refresh(context.projectId, now);

    await this.repository.updateRun(context.projectId, runId, {
      status: 'COMPLETED',
      completedAt: now,
      baselineId,
    });

    await this.audit.record({
      type: 'ANALYSIS_COMPLETED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        runId,
        itemCount: items.length,
        findingCount: findings.length,
        clarificationCount: clarifications.length,
        failedChunks: result.failedChunks,
      },
    });

    await this.audit.record({
      type: 'BASELINE_CREATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { baselineId, version, itemCount: items.length },
    });
  }

  private async fail(
    context: AnalysisContext,
    runId: string,
    reason: string,
    cause?: unknown,
  ): Promise<void> {
    const cancelled = reason === 'cancelled';

    await this.repository.updateRun(context.projectId, runId, {
      status: cancelled ? 'CANCELLED' : 'FAILED',
      failureReason: reason,
      completedAt: new Date(),
    });

    if (cause) {
      this.logger.error({ runId, reason }, 'Analysis run failed');
    }

    await this.audit.record({
      type: cancelled ? 'ANALYSIS_CANCELLED' : 'ANALYSIS_FAILED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      reason,
      metadata: { runId },
    });
  }

  async cancel(context: AnalysisContext, runId: string): Promise<AnalysisRun> {
    const run = await this.repository.findRun(context.projectId, runId);

    if (!run) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.RUN_NOT_FOUND, 404);
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(run.status)) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.ANALYSIS_NOT_RUNNING, 409);
    }

    // A flag rather than an interrupt. The pipeline checks it between tasks, so
    // a cancel takes effect at a point where nothing is half-written.
    const updated = await this.repository.updateRun(context.projectId, runId, {
      cancellationRequestedAt: new Date(),
    });

    return toRun(updated ?? run);
  }

  async listRuns(context: AnalysisContext): Promise<AnalysisRun[]> {
    const runs = await this.repository.listRuns(context.projectId);

    return runs.map(toRun);
  }

  async currentRun(context: AnalysisContext): Promise<AnalysisRun | null> {
    const run =
      (await this.repository.activeRun(context.projectId)) ??
      (await this.repository.latestRun(context.projectId));

    return run ? toRun(run) : null;
  }

  async readRun(context: AnalysisContext, runId: string): Promise<AnalysisRun> {
    const run = await this.repository.findRun(context.projectId, runId);

    if (!run) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.RUN_NOT_FOUND, 404);
    }

    return toRun(run);
  }

  /* -------------------------------------------------------- requirements */

  async listRequirements(context: AnalysisContext): Promise<RequirementItem[]> {
    const items = await this.repository.listItems(context.projectId);

    return items.map(toItem);
  }

  async readRequirement(context: AnalysisContext, itemId: string): Promise<RequirementItem> {
    const item = await this.repository.findItem(context.projectId, itemId);

    if (!item) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND, 404);
    }

    return toItem(item);
  }

  /**
   * Edits one requirement.
   *
   * Sets `editedByUser`, permanently. From here a later analysis may propose a
   * different wording but will not replace this one.
   */
  async editRequirement(
    context: AnalysisContext,
    itemId: string,
    edit: RequirementItemEdit,
  ): Promise<RequirementItem> {
    const existing = await this.repository.findItem(context.projectId, itemId);

    if (!existing) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND, 404);
    }

    if (existing.status === 'superseded') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_SUPERSEDED, 409);
    }

    const changingContent =
      edit.title !== undefined ||
      edit.statement !== undefined ||
      edit.category !== undefined ||
      edit.priority !== undefined ||
      edit.nfrDimension !== undefined;

    const updated = await this.repository.updateItem(
      context.projectId,
      itemId,
      edit.expectedVersion,
      {
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.statement !== undefined ? { statement: edit.statement } : {}),
        ...(edit.category !== undefined ? { category: edit.category } : {}),
        ...(edit.nfrDimension !== undefined
          ? { nfrDimension: edit.nfrDimension ?? undefined }
          : {}),
        ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
        ...(edit.status !== undefined
          ? { status: edit.status }
          : changingContent
            ? { status: 'edited' }
            : {}),
        ...(changingContent ? { editedByUser: true } : {}),
      },
    );

    if (!updated) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type:
        edit.status === 'accepted'
          ? 'REQUIREMENT_ACCEPTED'
          : edit.status === 'rejected'
            ? 'REQUIREMENT_REJECTED'
            : 'REQUIREMENT_EDITED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      // Which fields changed, never their contents.
      metadata: {
        itemId,
        key: updated.key,
        fields: Object.keys(edit).filter((key) => key !== 'expectedVersion'),
      },
    });

    await this.baselines.refresh(context.projectId, new Date());

    return toItem(updated);
  }

  /** A requirement typed by a person. Traceable if they cited something. */
  async addRequirement(
    context: AnalysisContext,
    request: ManualRequirement,
  ): Promise<RequirementItem> {
    const count = await this.repository.countItems(context.projectId);

    if (count >= ANALYSIS_LIMITS.maxRequirementItems) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.ITEM_LIMIT_REACHED, 422);
    }

    const baseline = await this.repository.currentBaseline(context.projectId);
    const evidenceContext = await this.loader.buildContext(context.projectId);
    const now = new Date();

    const references = request.references.flatMap((reference) => {
      const source = evidenceContext.sources.get(reference.sourceId);
      const block = source?.blocks.get(reference.blockId);

      return block
        ? [
            {
              kind: 'document' as const,
              sourceId: reference.sourceId,
              blockId: reference.blockId,
              excerpt: block.text.slice(0, 1_000),
              reference: block.reference,
              // Cited by a person, from the real block text. Verified by
              // construction rather than by comparison.
              verified: true,
            },
          ]
        : [];
    });

    const itemId = AnalysisRepository.newId('req');
    const sequence = await this.repository.nextItemSequence(context.projectId);

    await this.repository.insertItems([
      {
        itemId,
        projectId: context.projectId,
        runId: baseline?.runId ?? 'manual',
        key: requirementKey(sequence),
        title: request.title,
        statement: request.statement,
        category: request.category,
        ...(request.nfrDimension ? { nfrDimension: request.nfrDimension } : {}),
        priority: request.priority,
        references: references,
        evidenceConfidence: this.evidence.score(
          references,
          evidenceContext,
          {
            clarificationKeys: [],
            humanReviewed: true,
            inOpenConflict: false,
            hasOpenAmbiguity: false,
          },
          now,
        ),
        origin: 'manual',
        status: 'accepted',
        editedByUser: true,
        chunkIds: [],
        version: 0,
      },
    ]);

    await this.audit.record({
      type: 'REQUIREMENT_ADDED_MANUALLY',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { itemId, category: request.category, referenceCount: references.length },
    });

    await this.baselines.refresh(context.projectId, now);

    return this.readRequirement(context, itemId);
  }

  /* ------------------------------------------------------------ findings */

  async listFindings(context: AnalysisContext): Promise<{
    duplicates: ReturnType<typeof toDuplicate>[];
    conflicts: ReturnType<typeof toConflict>[];
    ambiguities: ReturnType<typeof toAmbiguity>[];
    gaps: ReturnType<typeof toGap>[];
  }> {
    const findings = await this.repository.listFindings(context.projectId);

    return {
      duplicates: findings.filter((finding) => finding.type === 'duplicate').map(toDuplicate),
      conflicts: findings.filter((finding) => finding.type === 'conflict').map(toConflict),
      ambiguities: findings.filter((finding) => finding.type === 'ambiguity').map(toAmbiguity),
      gaps: findings.filter((finding) => finding.type === 'missing').map(toGap),
    };
  }

  /**
   * Merges a duplicate group, or records that they are to stay separate.
   *
   * A merge supersedes the other items rather than deleting them. The decision
   * to merge is itself information — "these two documents said the same thing,
   * and we kept this wording" — and deleting the losers erases it.
   */
  async resolveDuplicate(
    context: AnalysisContext,
    groupId: string,
    request: ResolveDuplicate,
  ): Promise<void> {
    const finding = await this.repository.findFinding(context.projectId, groupId);

    if (finding?.type !== 'duplicate') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 404);
    }

    if (finding.status !== 'open') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_ALREADY_RESOLVED, 409);
    }

    if (request.action === 'merge') {
      if (!request.primaryId || !finding.itemIds.includes(request.primaryId)) {
        throw new AnalysisError(ANALYSIS_ERROR_CODES.INVALID_PRIMARY_ITEM, 422);
      }

      for (const itemId of finding.itemIds) {
        if (itemId === request.primaryId) {
          continue;
        }

        const item = await this.repository.findItem(context.projectId, itemId);

        if (item) {
          await this.repository.updateItem(context.projectId, itemId, item.version, {
            status: 'superseded',
            supersededById: request.primaryId,
          });
        }
      }
    }

    const updated = await this.repository.updateFinding(
      context.projectId,
      groupId,
      request.expectedVersion,
      {
        status: 'resolved',
        resolution: {
          action: request.action,
          ...(request.primaryId ? { primaryId: request.primaryId } : {}),
          ...(request.note ? { note: request.note } : {}),
          decidedAt: new Date().toISOString(),
        },
      },
    );

    if (!updated) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'DUPLICATE_RESOLVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { findingId: groupId, action: request.action, itemCount: finding.itemIds.length },
    });

    await this.baselines.refresh(context.projectId, new Date());
  }

  /**
   * Resolves a conflict, by a decision a person made.
   *
   * `choose` rejects the losing statements — it does not delete them, because
   * what the other document said is part of the record. `ask_client` raises a
   * clarification and leaves the conflict open, which is the honest outcome
   * when nobody in the room can settle it.
   */
  async resolveConflict(
    context: AnalysisContext,
    conflictId: string,
    request: ResolveConflict,
  ): Promise<void> {
    const finding = await this.repository.findFinding(context.projectId, conflictId);

    if (finding?.type !== 'conflict') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 404);
    }

    if (finding.status !== 'open') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_ALREADY_RESOLVED, 409);
    }

    if (request.action === 'choose') {
      if (!request.winningItemId || !finding.itemIds.includes(request.winningItemId)) {
        throw new AnalysisError(ANALYSIS_ERROR_CODES.INVALID_PRIMARY_ITEM, 422);
      }

      for (const itemId of finding.itemIds) {
        if (itemId === request.winningItemId) {
          continue;
        }

        const item = await this.repository.findItem(context.projectId, itemId);

        if (item) {
          await this.repository.updateItem(context.projectId, itemId, item.version, {
            status: 'rejected',
            editedByUser: true,
          });
        }
      }
    }

    if (request.action === 'rewrite' && request.replacementStatement) {
      const primary = finding.itemIds[0];
      const item = primary ? await this.repository.findItem(context.projectId, primary) : null;

      if (item) {
        await this.repository.updateItem(context.projectId, item.itemId, item.version, {
          statement: request.replacementStatement,
          status: 'edited',
          editedByUser: true,
        });
      }

      for (const itemId of finding.itemIds.slice(1)) {
        const other = await this.repository.findItem(context.projectId, itemId);

        if (other) {
          await this.repository.updateItem(context.projectId, itemId, other.version, {
            status: 'rejected',
            editedByUser: true,
          });
        }
      }
    }

    let clarificationId: string | undefined;

    if (request.action === 'ask_client') {
      clarificationId = await this.raiseClarification(context, finding.runId, {
        question:
          request.note ??
          'Two requirements in your documents contradict each other. Which one is correct?',
        rationale: (finding.payload as { summary?: string }).summary ?? 'A conflict was found.',
        category: 'conflict',
        impact: 'blocking',
        relatedItemIds: finding.itemIds,
        relatedConflictIds: [conflictId],
      });
    }

    const payload = finding.payload as {
      summary?: string;
      positions?: Record<string, unknown>[];
    };

    await this.repository.recordConflictVersion({
      conflictId,
      projectId: context.projectId,
      version: finding.version,
      status: finding.status,
      severity: finding.severity ?? 'major',
      kind: finding.kind ?? 'contradiction',
      summary: payload.summary ?? '',
      itemIds: [...finding.itemIds],
      positions: payload.positions ?? [],
      changedBy: 'user_decision',
      rationale: request.note ?? `Resolved by ${request.action}.`,
      recordedAt: new Date(),
    });

    const updated = await this.repository.updateFinding(
      context.projectId,
      conflictId,
      request.expectedVersion,
      {
        // `ask_client` leaves it open on purpose: the conflict is still real,
        // and it must keep blocking approval until somebody answers.
        status: request.action === 'ask_client' ? 'open' : 'resolved',
        resolution: {
          action: request.action,
          ...(request.winningItemId ? { winningItemId: request.winningItemId } : {}),
          ...(request.replacementStatement
            ? { replacementStatement: request.replacementStatement }
            : {}),
          ...(clarificationId ? { clarificationId } : {}),
          ...(request.note ? { note: request.note } : {}),
          decidedAt: new Date().toISOString(),
        },
      },
    );

    if (!updated) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'CONFLICT_RESOLVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { findingId: conflictId, action: request.action },
    });

    await this.baselines.refresh(context.projectId, new Date());
  }

  async resolveFinding(
    context: AnalysisContext,
    findingId: string,
    request: ResolveFinding,
  ): Promise<void> {
    const finding = await this.repository.findFinding(context.projectId, findingId);

    if (!finding) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 404);
    }

    const updated = await this.repository.updateFinding(
      context.projectId,
      findingId,
      request.expectedVersion,
      {
        status: request.status,
        resolution: {
          ...(request.note ? { note: request.note } : {}),
          decidedAt: new Date().toISOString(),
        },
      },
    );

    if (!updated) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'FINDING_RESOLVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { findingId, type: finding.type, status: request.status },
    });

    await this.baselines.refresh(context.projectId, new Date());
  }

  /**
   * What this conflict looked like before each change to it.
   *
   * The audit answer to "what was conflicting before the clarification?" —
   * positions copied whole at the time, so a requirement rewritten since cannot
   * change what the record says.
   */
  async conflictHistory(context: AnalysisContext, conflictId: string): Promise<ConflictVersion[]> {
    const finding = await this.repository.findFinding(context.projectId, conflictId);

    if (finding?.type !== 'conflict') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.FINDING_NOT_FOUND, 404);
    }

    const versions = await this.repository.listConflictVersions(context.projectId, conflictId);

    return versions.map((version) => ({
      conflictId: version.conflictId,
      projectId: version.projectId,
      version: version.version,
      status: version.status as ConflictVersion['status'],
      severity: version.severity as ConflictVersion['severity'],
      kind: version.kind as ConflictVersion['kind'],
      summary: version.summary,
      itemIds: version.itemIds,
      positions: version.positions as unknown as ConflictVersion['positions'],
      changedBy: version.changedBy as ConflictVersion['changedBy'],
      ...(version.clarificationKey ? { clarificationKey: version.clarificationKey } : {}),
      ...(version.rationale ? { rationale: version.rationale } : {}),
      recordedAt: version.recordedAt.toISOString(),
    }));
  }

  /* ------------------------------------------------------ clarifications */

  async listClarifications(context: AnalysisContext): Promise<Clarification[]> {
    const clarifications = await this.repository.listClarifications(context.projectId);

    return clarifications.map(toClarification);
  }

  /**
   * Records an answer.
   *
   * `isAssumption` is required rather than defaulted, and it is the whole
   * decision: an answer from the client is a fact, and one given on their
   * behalf is an assumption. Only the person in the room knows which this is,
   * and the application must not choose for them — an assumption recorded as a
   * fact is the most expensive error this document can carry.
   */
  /**
   * Records an answer, as a new version.
   *
   * Answering is not confirming. An answer typed after a meeting and an answer
   * the client has agreed to are different things, and only the second rewrites
   * requirements — so this stores the text and stops. Answering again supersedes
   * the previous version rather than overwriting it, marks the requirements that
   * version touched for revalidation, and takes any baseline built on it out of
   * date.
   */
  async answerClarification(
    context: AnalysisContext,
    clarificationId: string,
    request: AnswerClarification,
  ): Promise<Clarification> {
    const clarification = await this.repository.findClarification(
      context.projectId,
      clarificationId,
    );

    if (!clarification) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_FOUND, 404);
    }

    const now = new Date();
    const answers = (clarification.answers ?? []) as unknown as ClarificationAnswer[];
    const previous = answers.find((answer) => answer.status === 'current');
    const nextVersion = answers.length + 1;

    const superseded = answers.map((answer) =>
      answer.status === 'current'
        ? {
            ...answer,
            status: 'superseded' as const,
            supersededAt: now.toISOString(),
            supersededByVersion: nextVersion,
          }
        : answer,
    );

    const updated = await this.repository.updateClarification(
      context.projectId,
      clarificationId,
      request.expectedVersion,
      {
        status: 'ANSWERED',
        answers: [
          ...superseded,
          {
            version: nextVersion,
            text: request.text,
            answeredAt: now.toISOString(),
            isAssumption: request.isAssumption,
            status: 'current',
            affectedItemIds: [],
          },
        ],
      },
    );

    if (!updated) {
      throw new AnalysisError(
        ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_FOUND,
        409,
        'version_conflict',
      );
    }

    /*
     * A changed answer invalidates what the previous one produced. The
     * requirements it touched are flagged rather than reverted — reverting would
     * throw away wording a person may since have improved — and the baseline
     * goes out of date, because it was approved against a fact that has changed.
     */
    if (previous) {
      await this.repository.markForRevalidation(context.projectId, previous.affectedItemIds);
      await this.baselines.markOutdated(
        context.projectId,
        'clarification_changed',
        now,
        context.correlationId,
      );
    }

    await this.audit.record({
      type: 'CLARIFICATION_ANSWERED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      // Whether it was an assumption and which version — never the answer text,
      // which is a client's confidential material.
      metadata: {
        clarificationId,
        key: clarification.key,
        answerVersion: nextVersion,
        isAssumption: request.isAssumption,
        supersededVersion: previous?.version,
      },
    });

    await this.baselines.refresh(context.projectId, now);

    return toClarification(updated);
  }

  /**
   * Confirms the answer and folds it into the requirements it affects.
   *
   * The moment text somebody typed becomes evidence. From here the answer is
   * cited by the requirements it changed, counts towards their confidence, and
   * is versioned so a requirement written against it stays readable.
   *
   * An answer marked as an assumption takes the other path: it becomes an
   * assumption item, labelled, rather than rewriting anything. That is the only
   * route by which an assumption is ever created.
   */
  async confirmClarification(
    context: AnalysisContext,
    clarificationId: string,
    expectedVersion: number,
  ): Promise<IntegrationResult> {
    const clarification = await this.repository.findClarification(
      context.projectId,
      clarificationId,
    );

    if (!clarification) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_FOUND, 404);
    }

    const answers = (clarification.answers ?? []) as unknown as ClarificationAnswer[];
    const current = answers.find((answer) => answer.status === 'current');

    if (!current) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_ANSWERED, 422);
    }

    if (clarification.status === 'INTEGRATED' && current.confirmedAt) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.CLARIFICATION_ALREADY_ANSWERED, 409);
    }

    const now = new Date();

    const confirmed = await this.repository.updateClarification(
      context.projectId,
      clarificationId,
      expectedVersion,
      {
        status: 'INTEGRATING',
        answers: answers.map((answer) =>
          answer.version === current.version
            ? { ...answer, confirmedAt: now.toISOString() }
            : answer,
        ),
      },
    );

    if (!confirmed) {
      throw new AnalysisError(
        ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_FOUND,
        409,
        'version_conflict',
      );
    }

    if (current.isAssumption) {
      // The one path that creates an assumption, and only because a person said
      // this is what they are assuming rather than what the client confirmed.
      await this.recordAssumption(context, clarification, current, now);

      const settled = await this.repository.updateClarification(
        context.projectId,
        clarificationId,
        confirmed.version,
        { status: 'INTEGRATED' },
      );

      await this.baselines.refresh(context.projectId, now);

      return {
        clarificationId,
        clarificationKey: clarification.key,
        answerVersion: current.version,
        status: 'INTEGRATED',
        impacts: [],
        resolvedFindingIds: [],
        ...(settled ? {} : {}),
      };
    }

    const approved = await this.approvedItemIds(context.projectId);

    const result = await this.integration.integrate({
      projectId: context.projectId,
      correlationId: context.correlationId,
      clarification: confirmed,
      answerVersion: current.version,
      answerText: current.text,
      approvedItemIds: approved,
    });

    const latest = await this.repository.findClarification(context.projectId, clarificationId);
    const affectedItemIds = result.impacts.map((impact) => impact.itemId);

    await this.repository.updateClarification(
      context.projectId,
      clarificationId,
      latest?.version ?? confirmed.version,
      {
        status: result.status,
        answers: ((latest?.answers ?? []) as unknown as ClarificationAnswer[]).map((answer) =>
          answer.version === current.version
            ? {
                ...answer,
                affectedItemIds,
                ...(result.status === 'INTEGRATED' || result.status === 'NEEDS_REVIEW'
                  ? { integratedAt: now.toISOString() }
                  : {}),
                ...(result.failureReason ? { failureReason: result.failureReason } : {}),
              }
            : answer,
        ),
      },
    );

    /*
     * Every contradiction the answer touched, re-checked.
     *
     * A confirmed answer that changes one side of a conflict may have settled
     * it — and leaving it blocking would mean the client answered a question
     * and watched nothing happen. Equally, an answer that changes wording
     * without settling the disagreement must leave it blocking. Deterministic
     * rules decide which; see `conflict-reevaluation.ts`.
     */
    const reevaluated = await this.conflicts.reevaluate(
      reevaluationInputFrom(latest ?? confirmed, {
        projectId: context.projectId,
        correlationId: context.correlationId,
        answerText: current.text,
        answerVersion: current.version,
        answerConfirmed: true,
        isAssumption: current.isAssumption,
        appliedItemIds: result.impacts
          .filter((impact) => impact.outcome === 'applied')
          .map((impact) => impact.itemId),
        proposedItemIds: result.impacts
          .filter((impact) => impact.outcome === 'proposed')
          .map((impact) => impact.itemId),
      }),
    );

    if (reevaluated.length > 0) {
      await this.audit.record({
        type: 'CONFLICT_REEVALUATED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        // Counts and outcomes. The positions are a client's requirement text.
        metadata: {
          clarificationKey: clarification.key,
          answerVersion: current.version,
          evaluated: reevaluated.length,
          resolved: reevaluated.filter(
            (entry) => entry.resultingStatus === 'resolved_by_clarification',
          ).length,
          stillConflicting: reevaluated.filter(
            (entry) => entry.resultingStatus === 'still_conflicting',
          ).length,
          needsReview: reevaluated.filter((entry) => entry.resultingStatus === 'needs_review')
            .length,
        },
      });
    }

    /*
     * A baseline built before the answer no longer reflects it. Said plainly
     * rather than silently rewritten: the approved document still says what it
     * said, and its status records that the world moved.
     */
    if (result.impacts.some((impact) => impact.outcome !== 'unchanged')) {
      await this.baselines.markOutdated(
        context.projectId,
        'clarification_integrated',
        now,
        context.correlationId,
      );
    }

    await this.audit.record({
      type: 'CLARIFICATION_INTEGRATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      // Counts and outcomes only. The question, the answer and the requirement
      // text are all a client's confidential material.
      metadata: {
        clarificationId,
        key: clarification.key,
        answerVersion: current.version,
        status: result.status,
        applied: result.impacts.filter((impact) => impact.outcome === 'applied').length,
        proposed: result.impacts.filter((impact) => impact.outcome === 'proposed').length,
        unchanged: result.impacts.filter((impact) => impact.outcome === 'unchanged').length,
        resolvedFindings: result.resolvedFindingIds.length,
      },
    });

    await this.baselines.refresh(context.projectId, now);

    return result;
  }

  /** An explicit assumption, recorded as one and labelled as one. */
  private async recordAssumption(
    context: AnalysisContext,
    clarification: ClarificationDocument,
    answer: ClarificationAnswer,
    now: Date,
  ): Promise<void> {
    const sequence = await this.repository.nextItemSequence(context.projectId);
    const itemId = AnalysisRepository.newId('req');

    await this.repository.insertItems([
      {
        itemId,
        projectId: context.projectId,
        runId: clarification.runId,
        key: requirementKey(sequence),
        title: `Assumption: ${clarification.question.slice(0, 200)}`,
        statement: answer.text,
        category: 'assumption',
        priority: 'unspecified',
        references: [
          clarificationLink({
            clarificationId: clarification.clarificationId,
            clarificationKey: clarification.key,
            answerVersion: answer.version,
            text: answer.text,
          }),
        ],
        evidenceConfidence: this.evidence.score(
          [],
          await this.loader.buildContext(context.projectId),
          {
            clarificationKeys: [clarification.key],
            humanReviewed: true,
            inOpenConflict: false,
            hasOpenAmbiguity: false,
          },
          now,
        ),
        origin: 'clarification',
        status: 'accepted',
        editedByUser: true,
        chunkIds: [],
        version: 0,
      },
    ]);
  }

  /**
   * Requirements that cite this clarification, meaning its answer landed on them.
   *
   * Read from the traceability links rather than remembered from the
   * integration, so it is still correct after a proposal is accepted minutes or
   * days later.
   */
  private async appliedItemIdsFor(projectId: string, clarificationId: string): Promise<string[]> {
    const items = await this.repository.listItems(projectId);

    return items
      .filter((item) =>
        (item.references as { sourceId?: string; kind?: string }[]).some(
          (reference) =>
            reference.kind === 'clarification' && reference.sourceId === clarificationId,
        ),
      )
      .map((item) => item.itemId);
  }

  /** Requirement ids named by a baseline that has been approved. */
  private async approvedItemIds(projectId: string): Promise<ReadonlySet<string>> {
    const baselines = await this.repository.listBaselines(projectId);

    return new Set(
      baselines
        .filter((baseline) => baseline.status === 'approved' || baseline.status === 'outdated')
        .flatMap((baseline) => baseline.itemIds),
    );
  }

  /* -------------------------------------------------------- proposals */

  /** Every requirement with a revision waiting for a decision. */
  async listProposals(context: AnalysisContext): Promise<RequirementItem[]> {
    const items = await this.repository.listProposals(context.projectId);

    return items.map(toItem);
  }

  /**
   * Accepts, rejects or rewrites a proposed revision.
   *
   * Accepting is what turns a proposal into the requirement's wording, and it
   * records the previous version first. Rejecting keeps what is there and
   * clears the proposal — a decision, not an omission.
   */
  async resolveProposal(
    context: AnalysisContext,
    itemId: string,
    request: ResolveProposal,
  ): Promise<RequirementItem> {
    const item = await this.repository.findItem(context.projectId, itemId);

    if (!item) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND, 404);
    }

    const proposal = item.proposedRevision as unknown as ProposedRevision | undefined;

    if (!proposal) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.NO_PROPOSAL, 409);
    }

    const now = new Date();

    if (request.decision === 'reject') {
      const kept = await this.repository.updateItem(
        context.projectId,
        itemId,
        request.expectedVersion,
        { needsRevalidation: false },
        ['proposedRevision'],
      );

      if (!kept) {
        throw new AnalysisError(
          ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND,
          409,
          'version_conflict',
        );
      }

      await this.audit.record({
        type: 'PROPOSAL_REJECTED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { itemId, key: item.key, clarificationKey: proposal.clarificationKey },
      });

      await this.afterProposalDecision(context, now);

      return toItem(kept);
    }

    const statement =
      request.decision === 'edit'
        ? (request.statement ?? proposal.proposedStatement)
        : proposal.proposedStatement;

    await this.repository.recordVersion({
      itemId,
      projectId: context.projectId,
      version: item.version,
      title: item.title,
      statement: item.statement,
      category: item.category,
      priority: item.priority,
      status: item.status,
      references: item.references,
      changedBy: 'proposal_accepted',
      reason: `Accepted the revision proposed from ${proposal.clarificationKey}.`,
      clarificationKey: proposal.clarificationKey,
      recordedAt: now,
    });

    const existing = item.references.filter(
      (reference) => (reference as { sourceId?: string }).sourceId !== proposal.clarificationId,
    );
    const clarification = await this.repository.findClarification(
      context.projectId,
      proposal.clarificationId,
    );
    const current = ((clarification?.answers ?? []) as unknown as ClarificationAnswer[]).find(
      (answer) => answer.status === 'current',
    );

    const updated = await this.repository.updateItem(
      context.projectId,
      itemId,
      request.expectedVersion,
      {
        statement,
        status: 'edited',
        // Accepting a proposal is a human decision, so it counts as one from
        // here on: a later integration will propose to this item, not rewrite it.
        editedByUser: true,
        needsRevalidation: false,
        references: [
          ...existing,
          ...(current
            ? [
                clarificationLink({
                  clarificationId: proposal.clarificationId,
                  clarificationKey: proposal.clarificationKey,
                  answerVersion: current.version,
                  text: current.text,
                }) as unknown as Record<string, unknown>,
              ]
            : []),
        ],
      },
      ['proposedRevision'],
    );

    if (!updated) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'PROPOSAL_ACCEPTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        itemId,
        key: item.key,
        clarificationKey: proposal.clarificationKey,
        edited: request.decision === 'edit',
      },
    });

    await this.afterProposalDecision(context, now, {
      clarificationId: proposal.clarificationId,
      itemId,
      accepted: true,
    });

    return toItem(updated);
  }

  /**
   * Moves a clarification on once its last proposal has been decided.
   *
   * `NEEDS_REVIEW` means "the answer is not fully reflected yet". When no
   * proposal remains outstanding, it is.
   */
  private async afterProposalDecision(
    context: AnalysisContext,
    now: Date,
    settled?: { clarificationId: string; itemId: string; accepted: boolean },
  ): Promise<void> {
    /*
     * Accepting a proposal can be the last thing a conflict was waiting for:
     * `updates_applied` fails while a revision sits unaccepted, so a conflict
     * held at `needs_review` may become resolvable the moment somebody accepts.
     */
    if (settled?.accepted) {
      const clarification = await this.repository.findClarification(
        context.projectId,
        settled.clarificationId,
      );
      const current = ((clarification?.answers ?? []) as unknown as ClarificationAnswer[]).find(
        (answer) => answer.status === 'current',
      );

      if (clarification && current) {
        const applied = await this.appliedItemIdsFor(context.projectId, settled.clarificationId);

        await this.conflicts.reevaluate(
          reevaluationInputFrom(clarification, {
            projectId: context.projectId,
            correlationId: context.correlationId,
            answerText: current.text,
            answerVersion: current.version,
            answerConfirmed: current.confirmedAt !== undefined,
            isAssumption: current.isAssumption,
            appliedItemIds: applied,
            proposedItemIds: [],
          }),
        );
      }
    }

    const outstanding = await this.repository.listProposals(context.projectId);
    const blocked = new Set(
      outstanding.map(
        (item) => (item.proposedRevision as unknown as ProposedRevision).clarificationId,
      ),
    );

    for (const clarification of await this.repository.listClarifications(context.projectId)) {
      if (clarification.status === 'NEEDS_REVIEW' && !blocked.has(clarification.clarificationId)) {
        await this.repository.updateClarification(
          context.projectId,
          clarification.clarificationId,
          clarification.version,
          { status: 'INTEGRATED' },
        );
      }
    }

    await this.baselines.refresh(context.projectId, now);
  }

  /**
   * Dismisses a question, under controls.
   *
   * Dismissing a blocking question removes a gate on a document a client will
   * sign, so it is not a free-text escape hatch. The reviewer names a
   * disposition from a closed list, supplies a reference where the disposition
   * needs one, and acknowledges explicitly — and the reference is *checked*
   * before anything changes. A dismissal that cannot be checked is refused, and
   * the blocker stays exactly where it was.
   */
  async dismissClarification(
    context: AnalysisContext,
    clarificationId: string,
    request: DismissClarification,
  ): Promise<Clarification> {
    const clarification = await this.repository.findClarification(
      context.projectId,
      clarificationId,
    );

    if (!clarification) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_FOUND, 404);
    }

    // Validated first, and nothing is written until it passes: blockers are
    // recalculated only after the disposition stands up.
    const validation = await this.validateDismissal(context.projectId, request);

    const now = new Date();
    const updated = await this.repository.updateClarification(
      context.projectId,
      clarificationId,
      request.expectedVersion,
      {
        status: 'DISMISSED',
        dismissal: {
          reason: request.reason,
          disposition: request.disposition,
          ...(request.reference ? { reference: request.reference } : {}),
          validation,
          dismissedAt: now.toISOString(),
        },
      },
    );

    if (!updated) {
      throw new AnalysisError(
        ANALYSIS_ERROR_CODES.CLARIFICATION_NOT_FOUND,
        409,
        'version_conflict',
      );
    }

    await this.audit.record({
      type: 'CLARIFICATION_DISMISSED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      reason: request.disposition,
      // The disposition and what kind of thing it pointed at. Never the reason
      // text or the question, which are a client's confidential material.
      metadata: {
        clarificationId,
        key: updated.key,
        disposition: request.disposition,
        referenceKind: request.reference?.kind,
        blocking: clarification.blocksApproval,
      },
    });

    await this.baselines.refresh(context.projectId, now);

    return toClarification(updated);
  }

  /**
   * Checks that a dismissal's disposition is true, not merely asserted.
   *
   * Returns a plain-language note recorded with the dismissal, so a reader
   * months later can see what was verified rather than taking the disposition
   * on trust.
   */
  private async validateDismissal(
    projectId: string,
    request: DismissClarification,
  ): Promise<string> {
    const reference = request.reference;

    if (!DISPOSITIONS_REQUIRING_REFERENCE.includes(request.disposition)) {
      return `Recorded as ${request.disposition} with a reason.`;
    }

    if (!reference) {
      // Unreachable through the schema, which refuses it. Kept because a
      // refinement is not a guarantee once somebody adds a second caller.
      throw new AnalysisError(ANALYSIS_ERROR_CODES.DISMISSAL_REFERENCE_REQUIRED, 422);
    }

    if (reference.kind === 'source') {
      const sources = await this.loader.buildContext(projectId);

      if (!sources.sources.has(reference.id)) {
        throw new AnalysisError(ANALYSIS_ERROR_CODES.DISMISSAL_REFERENCE_INVALID, 422);
      }

      return `Checked: the named document is part of this project.`;
    }

    if (reference.kind === 'clarification') {
      const other = await this.repository.findClarification(projectId, reference.id);
      const answer = ((other?.answers ?? []) as unknown as ClarificationAnswer[]).find(
        (entry) => entry.status === 'current',
      );

      /*
       * A *confirmed* answer, not merely an answered question. Pointing at
       * another unanswered question would move a blocker rather than settle it.
       */
      if (!other || !answer?.confirmedAt) {
        throw new AnalysisError(ANALYSIS_ERROR_CODES.DISMISSAL_REFERENCE_INVALID, 422);
      }

      return `Checked: ${other.key} has a confirmed answer.`;
    }

    const item = await this.repository.findItem(projectId, reference.id);

    if (!item) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.DISMISSAL_REFERENCE_INVALID, 422);
    }

    if (request.disposition === 'REQUIREMENT_REMOVED') {
      /*
       * The requirement has to actually be gone. Saying one was removed while
       * it sits in the baseline is the one dismissal that would quietly hide a
       * real gap, so it is the one the application checks hardest.
       */
      if (item.status !== 'rejected' && item.status !== 'superseded') {
        throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_STILL_PRESENT, 422);
      }

      return `Checked: ${item.key} is ${item.status} and is not in the baseline.`;
    }

    return `Checked: ${item.key} is part of this project.`;
  }

  private async raiseClarification(
    context: AnalysisContext,
    runId: string,
    input: {
      question: string;
      rationale: string;
      category: string;
      impact: string;
      relatedItemIds: string[];
      relatedConflictIds: string[];
    },
  ): Promise<string> {
    const clarificationId = AnalysisRepository.newId('clr');
    const sequence = await this.repository.nextClarificationSequence(context.projectId);

    await this.repository.insertClarifications([
      {
        clarificationId,
        projectId: context.projectId,
        runId,
        key: clarificationKey(sequence),
        question: input.question,
        rationale: input.rationale,
        category: input.category,
        impact: input.impact,
        relatedItemIds: input.relatedItemIds,
        relatedConflictIds: input.relatedConflictIds,
        relatedFindingIds: [],
        status: 'UNANSWERED',
        answers: [],
        blocksApproval: true,
        version: 0,
      },
    ]);

    return clarificationId;
  }

  /** What this requirement said before, and why it changed. */
  async requirementHistory(
    context: AnalysisContext,
    itemId: string,
  ): Promise<RequirementVersion[]> {
    const item = await this.repository.findItem(context.projectId, itemId);

    if (!item) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.REQUIREMENT_NOT_FOUND, 404);
    }

    const versions = await this.repository.listVersions(context.projectId, itemId);

    return versions.map((version) => ({
      itemId: version.itemId,
      projectId: version.projectId,
      version: version.version,
      title: version.title,
      statement: version.statement,
      category: version.category as RequirementVersion['category'],
      priority: version.priority as RequirementVersion['priority'],
      status: version.status as RequirementVersion['status'],
      references: version.references as unknown as RequirementVersion['references'],
      changedBy: version.changedBy as RequirementVersion['changedBy'],
      ...(version.reason ? { reason: version.reason } : {}),
      ...(version.clarificationKey ? { clarificationKey: version.clarificationKey } : {}),
      recordedAt: version.recordedAt.toISOString(),
    }));
  }

  /* ------------------------------------------------------------ baseline */

  async readBaseline(context: AnalysisContext): Promise<BaselineView> {
    // Checked on read, so a user who changed a document sees the baseline
    // marked out of date the next time they look at it rather than the next
    // time somebody runs something.
    await this.baselines.propagateOutdated(context.projectId, new Date(), context.correlationId);

    const baseline = await this.repository.currentBaseline(context.projectId);

    if (!baseline) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_NOT_FOUND, 404);
    }

    return { baseline: toBaseline(baseline), notice: BASELINE_AI_NOTICE };
  }

  async listBaselineVersions(context: AnalysisContext): Promise<Baseline[]> {
    const baselines = await this.repository.listBaselines(context.projectId);

    return baselines.map(toBaseline);
  }

  async readBaselineVersion(context: AnalysisContext, version: number): Promise<Baseline> {
    const baseline = await this.repository.findBaselineVersion(context.projectId, version);

    if (!baseline) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_NOT_FOUND, 404);
    }

    return toBaseline(baseline);
  }

  async startReview(context: AnalysisContext): Promise<Baseline> {
    const baseline = await this.repository.currentBaseline(context.projectId);

    if (!baseline) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_NOT_FOUND, 404);
    }

    const updated = await this.repository.updateBaseline(
      context.projectId,
      baseline.baselineId,
      baseline.recordVersion,
      { status: 'in_review' },
    );

    await this.audit.record({
      type: 'BASELINE_REVIEW_STARTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { baselineId: baseline.baselineId, version: baseline.version },
    });

    return toBaseline(updated ?? baseline);
  }

  /**
   * Approves the baseline, if nothing is blocking.
   *
   * Recomputes the blockers immediately before checking them. The list a
   * browser last fetched may be minutes old, and approval is the one operation
   * where acting on a stale view has consequences that outlive the session.
   */
  async approve(context: AnalysisContext, request: ApproveBaseline): Promise<Baseline> {
    await this.baselines.refresh(context.projectId, new Date());

    const baseline = await this.repository.currentBaseline(context.projectId);

    if (!baseline) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_NOT_FOUND, 404);
    }

    if (baseline.status === 'approved') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_ALREADY_APPROVED, 409);
    }

    if (baseline.status === 'outdated') {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_OUTDATED, 409);
    }

    const view = toBaseline(baseline);

    if (view.itemCount === 0) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_EMPTY, 422);
    }

    if (!canApprove(view)) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_HAS_BLOCKERS, 422, undefined, {
        blockers: view.blockers,
      });
    }

    const approvedAt = new Date();
    const updated = await this.repository.updateBaseline(
      context.projectId,
      baseline.baselineId,
      request.expectedVersion,
      {
        status: 'approved',
        approvedAt,
        ...(request.note ? { approvalNote: request.note } : {}),
      },
    );

    if (!updated) {
      throw new AnalysisError(ANALYSIS_ERROR_CODES.BASELINE_NOT_FOUND, 409, 'version_conflict');
    }

    await this.audit.record({
      type: 'BASELINE_APPROVED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        baselineId: baseline.baselineId,
        version: baseline.version,
        itemCount: view.itemCount,
        acknowledgedAiAssistance: request.acknowledgedAiAssistance,
      },
    });

    return toBaseline(updated);
  }
}

export interface BaselineView {
  readonly baseline: Baseline;
  /** Shown wherever the baseline is. Never optional, never in a footer. */
  readonly notice: string;
}

/** Two statements are "the same requirement" for carry-forward purposes. */
function normalizeKey(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
