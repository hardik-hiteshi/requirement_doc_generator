import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CATALOG_VERSION,
  STACK_ERROR_CODES,
  TECHNOLOGY_CATALOG,
  TECHNOLOGY_CATEGORY_LABELS,
  aiMayReplace,
  authorityOf,
  calculateStackEvidence,
  findTechnology,
  fillsCategory,
  isDecided,
  requiredCategories,
  suitsProjectType,
  type CatalogEntry,
  type CategoryApplicabilityEntry,
  type ProjectType,
  type StackComponentStatus,
  type TechnologyCategory,
} from '@wdrg/contracts';

import { AppConfigService } from '../config/app-config.service';
import { AI_PROVIDER_PORT } from '../ports';
import { AuditService } from '../audit/audit.service';
import { AnalysisRepository } from '../analysis/analysis.repository';
import { resolveModelProfile } from '../analysis/models/resolve-profile';
import type { InferenceProvider } from '../analysis/providers/inference.types';
import { AiTaskRunner } from '../analysis/task-runner.service';
import { StackError } from './stack.errors';
import { StackRepository } from './stack.repository';
import { stackRecommendationOutputSchema } from './recommendation-schema';
import type { StackContext, StackService, StackView } from './stack.service';
import type { StackComponentDocument, StackSnapshotDocument } from './schemas/stack.schema';

/**
 * Asking a self-hosted model to fill the categories nobody has decided.
 *
 * The value here is genuine — a reviewer with a stack half-decided gets a
 * starting point with reasons attached. The danger is equally genuine, and it is
 * all of one shape: a model that quietly takes a decision away from the person
 * who made it.
 *
 * Four guards, in the order they act:
 *
 * **The request is filtered before the model sees it.** `categoriesToFill`
 * removes anything decided, anything locked, anything not applicable to this
 * project type, and anything conditional that no requirement justified. The
 * model is never asked about Next.js when the user has chosen Next.js, so a
 * recommendation to replace it cannot exist to be mishandled.
 *
 * **The catalogue is the vocabulary.** The prompt carries the applicable
 * entries and the semantic validator rejects any id not among them. A model
 * that invents `PostgresQL Enterprise` fails validation and is repaired or
 * dropped, rather than putting a technology that does not exist into a
 * proposal.
 *
 * **Authority is assigned here, not returned.** Everything written lands at
 * `AI_RECOMMENDED`, and `aiMayReplace` is checked again at the moment of the
 * write — the filter and the write both enforce it, because a filter is a
 * decision made earlier and the write is where the damage would happen.
 *
 * **A failure changes nothing.** The run is recorded as failed and the stack is
 * exactly as it was. A partial write here would leave a user unable to tell
 * which suggestions were considered and which were a crash.
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly repository: StackRepository,
    private readonly analysis: AnalysisRepository,
    private readonly runner: AiTaskRunner,
    private readonly audit: AuditService,
    @Optional()
    @Inject(AI_PROVIDER_PORT)
    private readonly provider: InferenceProvider | null,
  ) {}

  /** Whether suggestions are available at all in this deployment. */
  get isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * Fill the undecided categories.
   *
   * Synchronous, unlike Phase 4's analysis: one task over a small input, rather
   * than three per chunk over an entire document set. A stack of ten categories
   * is one call, and holding the connection for it is honest about the wait.
   */
  async recommend(
    context: StackContext,
    stack: StackService,
    snapshot: StackSnapshotDocument,
    requested: readonly TechnologyCategory[] | undefined,
  ): Promise<StackView> {
    const provider = this.provider;

    if (!provider) {
      throw new StackError(STACK_ERROR_CODES.RECOMMENDATION_NOT_CONFIGURED, 503);
    }

    if (await this.repository.activeRun(context.projectId)) {
      throw new StackError(STACK_ERROR_CODES.RECOMMENDATION_ALREADY_RUNNING, 409);
    }

    const components = await this.repository.listComponents(context.projectId, snapshot.version);
    const plan = await stack.planFor(context, snapshot);
    const projectTypes = snapshot.projectTypes as ProjectType[];
    const categories = this.categoriesToFill(plan, components, requested);

    if (categories.length === 0) {
      throw new StackError(STACK_ERROR_CODES.NOTHING_TO_RECOMMEND, 422);
    }

    const baseline = await this.baselineFor(context);
    const evidence = await this.evidenceFor(context, baseline?.itemIds ?? []);
    const allowed = this.allowedEntries(projectTypes, categories);
    const profile = resolveModelProfile(this.config);
    const model = this.config.ai.modelOverride.trim() || profile.model;
    const startedAt = Date.now();

    const runId = StackRepository.newId('rec');
    const decided = components.filter((component) =>
      isDecided(component.status as StackComponentStatus),
    );

    /*
     * The evidence is the client's requirement text and goes in as *evidence*,
     * delimited, in a user message. The catalogue and the decided technologies
     * are application facts and go in as prior results. Neither is ever
     * interpolated into the instruction — that boundary is Phase 4's and it does
     * not weaken because the task changed.
     */
    const priorResults = [
      `Project type: ${projectTypes.join(', ') || 'not stated'}`,
      `Categories to fill: ${categories.join(', ')}`,
      `Already decided (do not recommend for these): ${
        decided
          .map((component) => `${component.category}=${component.technologyName}`)
          .join(', ') || 'none'
      }`,
      `Catalogue (use only these ids):\n${allowed
        .map(
          (entry) =>
            `- ${entry.id} (${entry.category}) — ${entry.name}; ${entry.licence}; ${entry.costPosture}${entry.selfHostable ? '; self-hostable' : ''}`,
        )
        .join('\n')}`,
    ].join('\n\n');

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      stackVersion: snapshot.version,
      baselineVersion: baseline?.version ?? 0,
      projectTypes: [...projectTypes],
      categoriesRequested: [...categories],
      categoriesFilled: [],
      provider: provider.name,
      modelName: model,
      promptVersion: 'v1',
      inputSize: priorResults.length + evidence.reduce((sum, item) => sum + item.text.length, 0),
      outputSize: 0,
      durationMs: 0,
      status: 'running',
      retryCount: 0,
      failures: [],
      executions: [],
    });

    const knownIds = new Set(allowed.map((entry) => entry.id));
    const knownRequirements = new Set(evidence.map((item) => item.blockId));

    const outcome = await this.runner.run(provider, {
      taskId: 'stack.recommend',
      profile,
      model,
      evidence,
      priorResults,
      schema: stackRecommendationOutputSchema,
      semantic: {
        validate: (value) => [
          ...value.recommendations
            .filter((item) => !knownIds.has(item.technologyId))
            .map((item) => ({
              path: `recommendations.${item.category}`,
              message: `"${item.technologyId}" is not one of the catalogue ids you were given.`,
              reason: 'hallucinated_source_reference' as const,
            })),
          ...value.recommendations
            .filter((item) => !categories.includes(item.category))
            .map((item) => ({
              path: `recommendations.${item.category}`,
              message: `"${item.category}" was not one of the categories to fill.`,
              reason: 'unsupported_category' as const,
            })),
          ...value.recommendations
            .flatMap((item) =>
              item.requirementIds.map((requirementId) => ({ item, requirementId })),
            )
            .filter(({ requirementId }) => !knownRequirements.has(requirementId))
            .map(({ item, requirementId }) => ({
              path: `recommendations.${item.category}.requirementIds`,
              message: `"${requirementId}" is not a requirement you were given.`,
              reason: 'hallucinated_source_reference' as const,
            })),
          ...duplicateCategories(value.recommendations.map((item) => item.category)).map(
            (category) => ({
              path: `recommendations.${category}`,
              message: `You returned more than one recommendation for "${category}", which holds one.`,
              reason: 'duplicate_identifiers' as const,
            }),
          ),
        ],
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
        'Could not prepare technology suggestions; the stack was not changed',
      );

      throw new StackError(STACK_ERROR_CODES.RECOMMENDATION_FAILED, 503);
    }

    const filled: TechnologyCategory[] = [];

    for (const recommendation of outcome.value.recommendations) {
      const entry = findTechnology(recommendation.technologyId);

      if (!entry || !fillsCategory(entry, recommendation.category)) {
        continue;
      }

      /*
       * Checked again at the write, not only in the filter. The filter is a
       * decision made a moment ago against a list that could have changed; this
       * is the line where a user's choice would actually be overwritten.
       */
      const held = components.filter(
        (component) =>
          component.category === recommendation.category &&
          component.status !== 'REJECTED' &&
          component.status !== 'SUPERSEDED',
      );

      if (held.some((component) => !aiMayReplace(component.status as StackComponentStatus))) {
        this.logger.warn(
          { correlationId: context.correlationId, category: recommendation.category },
          'Discarded a suggestion for a category the user has already decided',
        );

        continue;
      }

      // An earlier suggestion in the same slot is replaced, and the record shows
      // it was replaced by another suggestion rather than by a person.
      for (const previous of held) {
        await this.repository.updateComponent(
          context.projectId,
          previous.componentId,
          previous.recordVersion,
          { status: 'SUPERSEDED', authority: authorityOf('SUPERSEDED') },
        );
      }

      const strength = calculateStackEvidence({
        evidenceKind:
          recommendation.requirementIds.length > 0
            ? 'CLIENT_REQUIREMENT'
            : 'ARCHITECTURAL_DERIVATION',
        requirementIds: recommendation.requirementIds,
        clarificationKeys: [],
        mandatedByRequirement: false,
        satisfiesStatedConstraint: false,
        userSelected: false,
        inCatalog: true,
        hasOpenConflict: false,
        missingInfrastructureContext: recommendation.requirementIds.length === 0,
      });

      await this.repository.createComponent({
        componentId: StackRepository.newId('cmp'),
        projectId: context.projectId,
        stackVersion: snapshot.version,
        category: recommendation.category,
        technologyId: entry.id,
        technologyName: entry.name,
        status: 'AI_RECOMMENDED',
        authority: authorityOf('AI_RECOMMENDED'),
        mandatory: false,
        /*
         * Never a version the model chose. It has no way to know what is
         * current, and a wrong version in a proposal is a commitment nobody can
         * meet. A reviewed catalogue entry may carry one; nothing else does.
         */
        version: entry.recommendedVersion
          ? { source: 'CATALOG_RECOMMENDED_VERSION', value: entry.recommendedVersion }
          : { source: 'UNSPECIFIED' },
        evidence: {
          /*
           * A recommendation with no requirement behind it is an architectural
           * derivation, and it is labelled as one. Presenting it as a client
           * requirement would put words in the client's mouth in their own
           * proposal.
           */
          kind:
            recommendation.requirementIds.length > 0
              ? 'CLIENT_REQUIREMENT'
              : 'ARCHITECTURAL_DERIVATION',
          requirementIds: recommendation.requirementIds,
          sourceIds: [],
          clarificationKeys: [],
          summary:
            recommendation.requirementIds.length > 0
              ? `Your approved requirements ${recommendation.requirementIds.join(', ')} lead here.`
              : 'Nobody asked for this directly — it follows from the other choices.',
        },
        evidenceStrength: strength.score,
        evidenceContributions: [...strength.contributions] as unknown as Record<string, unknown>[],
        licence: entry.licence,
        costPosture: entry.costPosture,
        selfHostable: entry.selfHostable,
        recommendation: {
          rationale: recommendation.rationale,
          benefits: recommendation.benefits,
          limitations: recommendation.limitations,
          risks: recommendation.risks,
          operationalConsiderations: recommendation.operationalConsiderations,
          ...(recommendation.alternativeTechnologyId
            ? { alternativeTechnologyId: recommendation.alternativeTechnologyId }
            : {}),
          ...(recommendation.alternativeReason
            ? { alternativeReason: recommendation.alternativeReason }
            : {}),
          modelConfidence: recommendation.modelConfidence,
          promptVersion: outcome.execution.promptVersion,
          runId,
        },
        riskAcknowledgements: [],
        notes: '',
      });

      filled.push(recommendation.category);

      await this.audit.record({
        type: 'TECH_COMPONENT_RECOMMENDED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { category: recommendation.category, catalogVersion: CATALOG_VERSION },
      });
    }

    await this.repository.updateRun(context.projectId, runId, {
      status: filled.length === categories.length ? 'completed' : 'partial',
      categoriesFilled: filled,
      outputSize: JSON.stringify(outcome.value).length,
      durationMs: Date.now() - startedAt,
      retryCount: outcome.execution.attempt - 1,
      executions: [outcome.execution],
      completedAt: new Date(),
    });

    const refreshed = await this.repository.currentSnapshot(context.projectId);

    if (refreshed) {
      await this.repository.updateSnapshot(
        context.projectId,
        refreshed.snapshotId,
        refreshed.recordVersion,
        { lastRecommendationRunId: runId },
      );
    }

    const latest = await this.repository.currentSnapshot(context.projectId);

    return stack.assemble(context, latest ?? snapshot);
  }

  /**
   * The categories a run may fill.
   *
   * Every exclusion here is one of the specification's rules, made mechanical:
   * a decided category is the user's, a not-applicable one does not exist for
   * this project, and a conditional one nothing justified is infrastructure
   * nobody asked for.
   */
  categoriesToFill(
    plan: readonly CategoryApplicabilityEntry[],
    components: readonly StackComponentDocument[],
    requested: readonly TechnologyCategory[] | undefined,
  ): readonly TechnologyCategory[] {
    const decided = new Set(
      components
        .filter(
          (component) =>
            isDecided(component.status as StackComponentStatus) ||
            component.status === 'AI_RECOMMENDED',
        )
        .map((component) => component.category),
    );

    const offerable = plan
      .filter((entry) => entry.applicability === 'required' || entry.applicability === 'optional')
      .map((entry) => entry.category);

    const candidates = requested
      ? offerable.filter((category) => requested.includes(category))
      : offerable;

    return candidates.filter((category) => !decided.has(category));
  }

  /** Catalogue entries that could fill these categories on this project. */
  private allowedEntries(
    projectTypes: readonly ProjectType[],
    categories: readonly TechnologyCategory[],
  ): readonly CatalogEntry[] {
    return TECHNOLOGY_CATALOG.filter(
      (entry) =>
        categories.some((category) => fillsCategory(entry, category)) &&
        (projectTypes.length === 0 || projectTypes.some((type) => suitsProjectType(entry, type))) &&
        entry.maturity !== 'deprecated',
    );
  }

  /**
   * The approved requirements, as evidence blocks.
   *
   * Keyed by requirement id so a citation is checkable: the semantic validator
   * rejects any id the model did not receive, which is what stops a
   * recommendation citing REQ-99 on a project that has fourteen requirements.
   */
  private async evidenceFor(
    context: StackContext,
    itemIds: readonly string[],
  ): Promise<{ blockId: string; text: string }[]> {
    if (itemIds.length === 0) {
      return [];
    }

    const items = await this.analysis.findItemsByIds(context.projectId, itemIds);

    return items
      .filter((item) => item.status !== 'rejected' && item.status !== 'superseded')
      .map((item) => ({
        blockId: item.itemId,
        text: `${item.title}\n${item.statement}`,
      }));
  }

  private async baselineFor(
    context: StackContext,
  ): Promise<{ version: number; itemIds: string[] } | null> {
    const baselines = await this.analysis.listBaselines(context.projectId);
    const approved = baselines.find((baseline) => baseline.status === 'approved');

    return approved ? { version: approved.version, itemIds: [...approved.itemIds] } : null;
  }
}

/** Categories the model returned more than once, for a slot that holds one. */
function duplicateCategories(categories: readonly TechnologyCategory[]): TechnologyCategory[] {
  const seen = new Set<TechnologyCategory>();
  const duplicates = new Set<TechnologyCategory>();

  for (const category of categories) {
    if (seen.has(category)) {
      duplicates.add(category);
    }

    seen.add(category);
  }

  return [...duplicates];
}

/** Re-exported so tests can assert the plan without reaching into the service. */
export { requiredCategories, TECHNOLOGY_CATEGORY_LABELS };
