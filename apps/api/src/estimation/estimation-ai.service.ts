import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ESTIMATION_ERROR_CODES, PRODUCTIVITY_MODEL_VERSION } from '@wdrg/contracts';

import { AppConfigService } from '../config/app-config.service';
import { AI_PROVIDER_PORT } from '../ports';
import { AnalysisRepository } from '../analysis/analysis.repository';
import { resolveModelProfile } from '../analysis/models/resolve-profile';
import type { InferenceProvider } from '../analysis/providers/inference.types';
import { AiTaskRunner } from '../analysis/task-runner.service';
import { EstimationError } from './estimation.errors';
import { EstimationRepository } from './estimation.repository';
import { estimationAssessmentSchema } from './estimation-schema';
import type {
  EstimationContext,
  EstimationService,
  EstimateView,
  ModelProposal,
} from './estimation.service';
import type { EstimateSnapshotDocument } from './schemas/estimation.schema';

/**
 * Asking a self-hosted model how hard each requirement is.
 *
 * The genuinely useful half of the hybrid model: a model reading a hundred
 * requirements spots the multi-step approval and the undocumented integration
 * faster than a person scanning them, and it does not get bored on the eightieth.
 *
 * What it never does is arithmetic. Its output carries a task category, a
 * complexity, drivers and unknowns — and every one of those is fed into
 * `estimateUnit`, which turns them into hours using rules in the repository. So
 * the model's contribution is *judgement about the requirement*, and the
 * application's is *what that judgement is worth in hours*.
 *
 * Three guards:
 *
 * **Requirement ids are verified.** The semantic validator rejects any id the
 * run was not given, which stops an assessment attaching to something that does
 * not exist.
 *
 * **A failure changes nothing.** The deterministic engine still runs, so the
 * plan is complete either way — the only difference is that nobody looked at
 * the requirements individually.
 *
 * **User overrides are never in scope.** The run is handed the requirements
 * that have no user-authored line, and the storage-layer delete filter enforces
 * it again.
 */
@Injectable()
export class EstimationAiService {
  private readonly logger = new Logger(EstimationAiService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly repository: EstimationRepository,
    private readonly analysis: AnalysisRepository,
    private readonly runner: AiTaskRunner,
    @Optional()
    @Inject(AI_PROVIDER_PORT)
    private readonly provider: InferenceProvider | null,
  ) {}

  get isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * Run an estimation, with or without a model.
   *
   * `useAi: false` is not a degraded path — it is the deterministic engine on
   * its own, and it produces a complete plan. That is what makes the whole step
   * usable with `AI_PROVIDER=disabled`.
   */
  async run(
    context: EstimationContext,
    estimation: EstimationService,
    snapshot: EstimateSnapshotDocument,
    useAi: boolean,
  ): Promise<EstimateView> {
    if (await this.repository.activeRun(context.projectId)) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATION_ALREADY_RUNNING, 409);
    }

    const upstream = await estimation.upstream(context);

    if (!upstream.baseline) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.BASELINE_NOT_APPROVED, 422);
    }

    if (!upstream.stack) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.STACK_NOT_LOCKED, 422);
    }

    const provider = this.provider;

    if (useAi && !provider) {
      throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATION_NOT_CONFIGURED, 503);
    }

    const startedAt = Date.now();
    const runId = EstimationRepository.newId('erun');
    const items = await this.analysis.findItemsByIds(context.projectId, upstream.baseline.itemIds);
    const live = items.filter((item) => item.status !== 'rejected' && item.status !== 'superseded');

    const profile = useAi ? resolveModelProfile(this.config) : null;
    const model = profile ? this.config.ai.modelOverride.trim() || profile.model : 'none';

    const evidence = live.map((item) => ({
      blockId: item.itemId,
      text: `${item.title}\n${item.statement}`,
    }));

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      estimateVersion: snapshot.version,
      baselineVersion: upstream.baseline.version,
      stackVersion: upstream.stack.version,
      requirementCount: live.length,
      unitsProduced: 0,
      provider: useAi && provider ? provider.name : 'none',
      modelName: model,
      promptVersion: useAi ? 'v1' : 'none',
      productivityModelVersion: PRODUCTIVITY_MODEL_VERSION,
      inputSize: evidence.reduce((total, block) => total + block.text.length, 0),
      outputSize: 0,
      durationMs: 0,
      status: 'running',
      retryCount: 0,
      failures: [],
      executions: [],
      preservedOverrides: 0,
    });

    let proposals = new Map<string, ModelProposal>();
    let retryCount = 0;
    let outputSize = 0;

    if (useAi && provider && profile) {
      const known = new Set(live.map((item) => item.itemId));

      /*
       * The locked technologies go in as prior results — application facts, not
       * evidence — and the prompt says outright that they are already decided.
       * The requirement text goes in as delimited evidence, under Phase 4's
       * instruction/evidence boundary, which this phase does not weaken.
       */
      const priorResults = [
        `Technologies already committed to (do not propose changing any of these): ${
          upstream.stackContext.technologies
            .map((technology) => `${technology.category}=${technology.name}`)
            .join(', ') || 'none recorded'
        }`,
        `Roles this project has: ${upstream.stackContext.roles.join(', ')}`,
      ].join('\n\n');

      const outcome = await this.runner.run(provider, {
        taskId: 'estimation.assess',
        profile,
        model,
        evidence,
        priorResults,
        schema: estimationAssessmentSchema,
        semantic: {
          validate: (value) =>
            value.assessments
              .filter((assessment) => !known.has(assessment.requirementId))
              .map((assessment) => ({
                path: `assessments.${assessment.requirementId}`,
                message: `"${assessment.requirementId}" is not a requirement you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
        },
        correlationId: context.correlationId,
      });

      if (!outcome.ok) {
        await this.repository.updateRun(context.projectId, runId, {
          status: 'failed',
          failures: [outcome.reason],
          durationMs: Date.now() - startedAt,
          executions: [outcome.execution],
          completedAt: new Date(),
        });

        this.logger.warn(
          { correlationId: context.correlationId, reason: outcome.reason },
          'Could not assess the requirements; the plan was not changed',
        );

        throw new EstimationError(ESTIMATION_ERROR_CODES.ESTIMATION_FAILED, 503);
      }

      retryCount = outcome.execution.attempt - 1;
      outputSize = JSON.stringify(outcome.value).length;
      proposals = new Map(
        outcome.value.assessments.map((assessment) => [
          assessment.requirementId,
          {
            proposedCategory: assessment.taskCategory,
            proposedComplexity: assessment.complexity,
            proposedDrivers: assessment.complexityDrivers,
            proposedUncertainty: assessment.uncertaintySources,
            proposedRationale: assessment.rationale,
          },
        ]),
      );
    }

    const result = await estimation.generate(context, snapshot, proposals);

    await this.repository.updateRun(context.projectId, runId, {
      status: 'completed',
      unitsProduced: result.produced,
      preservedOverrides: result.preserved,
      outputSize,
      durationMs: Date.now() - startedAt,
      retryCount,
      completedAt: new Date(),
    });

    const refreshed = await this.repository.currentSnapshot(context.projectId);

    return estimation.assemble(context, refreshed ?? snapshot);
  }
}
