import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  correctionLimits,
  DOCUMENT_ERROR_CODES,
  DOCUMENT_SHAPE_BY_TYPE,
  EVIDENCE_NOTICE,
  featureTotalHours,
  isSectionProtected,
  isTooVague,
  joinDetailPoints,
  looksLikeSecret,
  MODEL_RAISABLE_KINDS,
  UNDERSTANDING_SECTIONS,
  understandingSection,
  type AiTaskId,
  type DocumentSnapshot,
  type DocumentType,
  type FeatureRow,
  type ApplyCorrection,
  type GenerateDocument,
  type RequirementItem,
  type ValidationFinding,
} from '@wdrg/contracts';

import { AppConfigService } from '../config/app-config.service';
import { resolveModelProfile } from '../analysis/models/resolve-profile';
import type { InferenceProvider } from '../analysis/providers/inference.types';
import { AiTaskRunner } from '../analysis/task-runner.service';
import { AI_PROVIDER_PORT } from '../ports';
import { DocumentError } from './documents.errors';
import { DocumentsRepository } from './documents.repository';
import { DocumentsService, type DocumentContext } from './documents.service';
import { payloadText } from './documents.mapper';
import {
  acceptanceCriteriaOutputSchema,
  clientDependenciesOutputSchema,
  wbsTasksOutputSchema,
  assumptionCandidatesOutputSchema,
  documentFeaturesSchema,
  documentPlanSchema,
  documentSectionOutputSchema,
  documentValidationOutputSchema,
  type DocumentSectionOutput,
} from './document-schemas';
import type { SemanticValidator } from '../analysis/output/structured-output';
import type { ComposedContent, ComposedSection } from './composers/composer.types';
import type { UpstreamSnapshot } from './upstream.reader';

/**
 * The model's half of document generation.
 *
 * ## What the model contributes, and what it cannot
 *
 * It writes prose into sections the application chose, from requirements the
 * application selected. It names modules, submodules and screens, and describes
 * features in a sentence somebody can read. That is genuinely valuable and hard
 * to do deterministically.
 *
 * It supplies no hours, no status, no version, no technology, no source location
 * and no section that is not in the template. Not because the prompt asks it not
 * to — because the schemas have nowhere to put any of them, and because every
 * requirement id it cites is checked against the ids it was given before anything
 * is stored.
 *
 * ## Four tasks, not one prompt
 *
 * `document.plan` decides what each section has evidence for. `document.section`
 * writes one section. `document.features` groups requirements into rows.
 * `document.validate` reads the finished document back. One giant prompt would
 * make every failure a whole-document failure, make attribution impossible, and
 * put a fifteen-section document and a thousand requirements in one context
 * window.
 *
 * ## Failure changes nothing
 *
 * Every path falls back to the deterministic composition, which is complete. So
 * `AI_PROVIDER=disabled` is a supported configuration rather than a degraded one:
 * the document is correct and a little stiff, and every section can be rewritten
 * by hand.
 */
@Injectable()
export class DocumentsAiService {
  private readonly logger = new Logger(DocumentsAiService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly documents: DocumentsService,
    private readonly repository: DocumentsRepository,
    private readonly runner: AiTaskRunner,
    @Optional()
    @Inject(AI_PROVIDER_PORT)
    private readonly provider: InferenceProvider | null,
  ) {}

  get isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * Generate a document, with or without a model.
   *
   * `useAi: false` is not a lesser path — it is the deterministic composer on its
   * own, which produces every section and every row.
   */
  async generate(
    context: DocumentContext,
    type: DocumentType,
    request: GenerateDocument,
    instruction?: string,
  ): Promise<DocumentSnapshot> {
    if (request.useAi && !this.provider) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATION_NOT_CONFIGURED, 503);
    }

    const existing = await this.documents.currentDocument(context, type);

    if (await this.repository.activeRun(context.projectId, type)) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATING, 409);
    }

    const upstream = await this.documents.readUpstream(context);
    const composer = this.documents.composerFor(type);
    const deterministic = composer.compose(upstream.context);

    const runId = DocumentsRepository.newId('drun');
    const startedAt = new Date();
    const profile = request.useAi ? resolveModelProfile(this.config) : null;
    const model = profile ? this.config.ai.modelOverride.trim() || profile.model : 'none';

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      type,
      kind: existing ? 'FULL_REGENERATION' : 'FULL_GENERATION',
      status: 'RUNNING',
      ...(upstream.context.baseline ? { baselineVersion: upstream.context.baseline.version } : {}),
      ...(upstream.context.stack ? { stackVersion: upstream.context.stack.version } : {}),
      ...(upstream.context.estimate ? { estimateVersion: upstream.context.estimate.version } : {}),
      provider: request.useAi && this.provider ? this.provider.name : 'none',
      modelName: model,
      promptVersions: request.useAi ? { 'document.plan': 'v1', 'document.section': 'v1' } : {},
      sectionKeys: deterministic.sections.map((section) => section.key),
      startedAt,
      deterministicOnly: !request.useAi,
    });

    let content = deterministic;
    let outputCharacters = 0;

    if (request.useAi && this.provider && profile) {
      try {
        const written =
          DOCUMENT_SHAPE_BY_TYPE[type] === 'ROWS'
            ? await this.writeFeatures(context, upstream, deterministic, model, instruction)
            : await this.writeSections(context, upstream, deterministic, model, instruction);

        content = written.content;
        outputCharacters = written.outputCharacters;
      } catch (cause) {
        /*
         * The deterministic content is already complete, so a model failure
         * degrades readability and nothing else. Recorded as a failed run and
         * then ignored — refusing to produce a document because prose generation
         * failed would be worse for the user in every case.
         */
        this.logger.warn(
          { cause, documentType: type, correlationId: context.correlationId },
          'Document prose generation failed; using the deterministic composition',
        );
      }
    }

    const snapshot = await this.documents.generate(context, type, request, content);

    await this.repository.finishRun(runId, {
      status: 'COMPLETED',
      completedAt: new Date(),
      outputCharacters,
      inputCharacters: this.evidenceSize(upstream),
    });

    return snapshot;
  }

  /**
   * Rewrite one section.
   *
   * A correction instruction travels as evidence, inside the delimiters, exactly
   * like requirement text. It is a request about wording — it cannot widen scope,
   * name a technology or change a number, and the prompt says so because
   * reinforcement is free. The structural part is that it is not in the
   * instruction channel at all.
   */
  async regenerateSection(
    context: DocumentContext,
    type: DocumentType,
    sectionId: string,
    expectedVersion: number,
    useAi: boolean,
    instruction?: string,
  ): Promise<DocumentSnapshot> {
    if (useAi && !this.provider) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATION_NOT_CONFIGURED, 503);
    }

    const sections = await this.documents.currentSections(context, type);
    const section = sections.find((candidate) => candidate.sectionId === sectionId);

    if (!section) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
    }

    const upstream = await this.documents.readUpstream(context);
    const composer = this.documents.composerFor(type);
    const composed = composer.compose(upstream.context);
    const fresh = composed.sections.find((candidate) => candidate.key === section.key);

    let body = fresh?.body ?? section.body;
    const runId = DocumentsRepository.newId('drun');

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      type,
      kind: 'SECTION_REGENERATION',
      status: 'RUNNING',
      provider: useAi && this.provider ? this.provider.name : 'none',
      modelName: useAi ? this.modelName() : 'none',
      promptVersions: useAi ? { 'document.section': 'v1' } : {},
      sectionKeys: [section.key],
      startedAt: new Date(),
      deterministicOnly: !useAi,
    });

    if (useAi && this.provider) {
      const profile = resolveModelProfile(this.config);
      const requirements = this.requirementsForKeys(upstream, fresh?.references ?? []);

      const outcome = await this.runner.run(this.provider, {
        taskId: 'document.section',
        profile,
        model: this.modelName(),
        evidence: [
          ...requirements.map((requirement) => ({
            blockId: requirement.key,
            text: `${requirement.title}\n${requirement.statement}`,
          })),
          ...(instruction
            ? [
                {
                  blockId: 'user-correction',
                  text: `A note from the person reviewing this document about how they would like this section worded. ${EVIDENCE_NOTICE}\n\n${instruction}`,
                },
              ]
            : []),
        ],
        priorResults: this.sectionBrief(section.key),
        schema: documentSectionOutputSchema,
        semantic: this.citationValidator(requirements.map((requirement) => requirement.key)),
        correlationId: context.correlationId,
      });

      if (outcome.ok) {
        body = outcome.value.body;
      }
    }

    await this.repository.finishRun(runId, { status: 'COMPLETED', completedAt: new Date() });

    return this.documents.regenerateSection(
      context,
      type,
      sectionId,
      expectedVersion,
      body,
      instruction,
    );
  }

  /**
   * Validate, with the model reading the document back.
   *
   * Additive only. The findings it returns are marked `MODEL`, restricted to the
   * judgement kinds, and raised as warnings — a model cannot create a blocking
   * finding, and it cannot clear or downgrade a deterministic one.
   */
  async validate(
    context: DocumentContext,
    type: DocumentType,
    useAi: boolean,
  ): Promise<DocumentSnapshot> {
    if (!useAi || !this.provider) {
      return this.documents.validate(context, type, [], false);
    }

    const sections = await this.documents.currentSections(context, type);
    const upstream = await this.documents.readUpstream(context);

    if (sections.length === 0) {
      return this.documents.validate(context, type, [], false);
    }

    const profile = resolveModelProfile(this.config);
    const known = new Set(upstream.context.requirements.map((requirement) => requirement.key));

    const outcome = await this.runner.run(this.provider, {
      taskId: 'document.validate',
      profile,
      model: this.modelName(),
      evidence: sections
        .filter((section) => section.body.trim().length > 0)
        .map((section) => ({ blockId: section.key, text: `${section.title}\n${section.body}` })),
      priorResults: `Approved requirement ids: ${[...known].join(', ') || 'none'}`,
      schema: documentValidationOutputSchema,
      correlationId: context.correlationId,
    });

    if (!outcome.ok) {
      /* A failed read-back is not a validation failure. The checks still ran. */
      return this.documents.validate(context, type, [], false);
    }

    const keys = new Set(sections.map((section) => section.key));

    const findings: ValidationFinding[] = outcome.value.findings
      .filter(
        (finding) =>
          keys.has(finding.sectionKey) &&
          (MODEL_RAISABLE_KINDS as readonly string[]).includes(finding.kind),
      )
      .map((finding) => ({
        kind: finding.kind as ValidationFinding['kind'],
        /* A judgement is a warning. Only arithmetic blocks approval. */
        severity: 'WARNING' as const,
        detectedBy: 'MODEL' as const,
        summary: `${finding.statement} — ${finding.explanation}`,
        action: 'Reword it, cite the requirement that supports it, or accept the warning.',
        subjectIds: [finding.sectionKey],
      }));

    return this.documents.validate(context, type, findings, true);
  }

  /**
   * Rewrite the wording of selected feature rows.
   *
   * The model is asked for module, submodule, screen and description for the
   * requirements behind the selected rows — nothing else, because its schema has
   * nothing else. Hours, estimate units and technologies are not sent to it and are
   * not read back from it; the engine carries them forward from the row.
   *
   * So a model response that tries to return effort fails `.strict()` validation
   * and the run falls back to the wording the rows already had. There is no path in
   * which a document rewrite changes an approved figure.
   */
  async regenerateFeatures(
    context: DocumentContext,
    type: DocumentType,
    selection: { readonly featureIds?: readonly string[]; readonly module?: string },
    expectedVersion: number,
    useAi: boolean,
    instruction?: string,
  ): Promise<{ snapshot: DocumentSnapshot; proposed: boolean; runId: string }> {
    if (useAi && !this.provider) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATION_NOT_CONFIGURED, 503);
    }

    const upstream = await this.documents.readUpstream(context);
    const runId = DocumentsRepository.newId('drun');

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      type,
      kind: 'SECTION_REGENERATION',
      status: 'RUNNING',
      provider: useAi && this.provider ? this.provider.name : 'none',
      modelName: useAi ? this.modelName() : 'none',
      promptVersions: useAi ? { 'document.features': 'v1' } : {},
      sectionKeys: selection.module ? [selection.module] : [...(selection.featureIds ?? [])],
      startedAt: new Date(),
      deterministicOnly: !useAi,
    });

    const named = new Map<
      string,
      { module: string; submodule: string; screen: string; description: string }
    >();

    if (useAi && this.provider) {
      const known = new Set(upstream.context.requirements.map((requirement) => requirement.key));

      const outcome = await this.runner.run(this.provider, {
        taskId: 'document.features',
        profile: resolveModelProfile(this.config),
        model: this.modelName(),
        evidence: [
          ...upstream.context.requirements.map((requirement) => ({
            blockId: requirement.key,
            text: `${requirement.title}\n${requirement.statement}`,
          })),
          ...(instruction
            ? [
                {
                  blockId: 'user-correction',
                  text: `A note from the person reviewing this document about how they would like these features worded. ${EVIDENCE_NOTICE}\n\n${instruction}`,
                },
              ]
            : []),
        ],
        priorResults: [
          `Project type: ${upstream.context.projectTypes.join(', ') || 'unspecified'}`,
          `This project ${this.hasInterface(upstream) ? 'has a user interface' : 'has no user interface, so every Screen must be empty'}.`,
          'Return wording only. Hours are not yours to set and there is nowhere to put them.',
        ].join('\n'),
        schema: documentFeaturesSchema,
        semantic: {
          validate: (value) =>
            value.features
              .flatMap((feature) => feature.requirementIds)
              .filter((id) => !known.has(id))
              .map((id) => ({
                path: `features.${id}`,
                message: `"${id}" is not a requirement you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
        },
        correlationId: context.correlationId,
      });

      if (outcome.ok) {
        /*
         * Joined on the estimate units behind a row, which is a row's identity.
         * A wording suggestion for requirements with no row is simply unused —
         * it would otherwise be a feature with no hours, which is scope with no
         * price.
         */
        const unitsByRequirement = new Map<string, string>();

        for (const row of await this.documents.currentFeatures(context, type)) {
          for (const requirementId of row.requirementIds) {
            unitsByRequirement.set(requirementId, row.estimateUnitIds.join('|'));
          }
        }

        for (const feature of outcome.value.features) {
          for (const requirementId of feature.requirementIds) {
            const unitKey = unitsByRequirement.get(requirementId);

            if (unitKey) {
              named.set(unitKey, {
                module: feature.module,
                submodule: feature.submodule,
                screen: this.hasInterface(upstream) ? feature.screen : '',
                description: feature.description.includes('|')
                  ? feature.description
                  : joinDetailPoints([feature.description]),
              });
            }
          }
        }
      }
    }

    const result = await this.documents.regenerateFeatures(
      context,
      type,
      selection,
      expectedVersion,
      named,
      instruction,
    );

    await this.repository.finishRun(runId, { status: 'COMPLETED', completedAt: new Date() });

    return { snapshot: result.snapshot, proposed: result.proposed, runId };
  }

  /**
   * Applies a correction instruction, whatever it targets.
   *
   * One entry point for all four target kinds, because a correction is one kind of
   * event: a person asked for something different, it was recorded, a run carried
   * it out, and the outcome went back on the record. The routing below is about
   * *what* to regenerate, not about what a correction is.
   */
  async applyCorrection(
    context: DocumentContext,
    type: DocumentType,
    request: ApplyCorrection,
  ): Promise<{ snapshot: DocumentSnapshot; limits: readonly string[] }> {
    const current = await this.documents.currentDocument(context, type);

    if (!current) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_GENERATED, 422);
    }

    const correctionId = await this.documents.openCorrection(
      context,
      type,
      request,
      current.version,
    );

    /*
     * Reported, never enforced by filtering. The structural defences are elsewhere;
     * this tells the user which part of their request will not have the effect they
     * expect, instead of silently doing half of it.
     */
    const limits = correctionLimits(request.instruction);

    try {
      let snapshot: DocumentSnapshot;
      let proposed = false;
      let runId: string | undefined;

      if (request.targetKind === 'SECTION') {
        const sections = await this.documents.currentSections(context, type);
        const section = sections.find((candidate) => candidate.key === request.targetKey);

        if (!section) {
          throw new DocumentError(DOCUMENT_ERROR_CODES.SECTION_NOT_FOUND, 404);
        }

        proposed = isSectionProtected(section.origin);
        snapshot = await this.regenerateSection(
          context,
          type,
          section.sectionId,
          request.expectedVersion,
          request.useAi,
          request.instruction,
        );
      } else if (request.targetKind === 'FEATURE' || request.targetKind === 'MODULE') {
        const result = await this.regenerateFeatures(
          context,
          type,
          request.targetKind === 'MODULE'
            ? { module: request.targetKey }
            : { featureIds: [request.targetKey!] },
          request.expectedVersion,
          request.useAi,
          request.instruction,
        );

        snapshot = result.snapshot;
        proposed = result.proposed;
        runId = result.runId;
      } else {
        snapshot = await this.generate(
          context,
          type,
          {
            useAi: request.useAi,
            reason: 'A correction was applied',
            expectedVersion: request.expectedVersion,
          },
          request.instruction,
        );
        proposed = snapshot.sections.some((section) => section.proposedBody !== undefined);
      }

      await this.documents.closeCorrection(correctionId, proposed ? 'PROPOSED' : 'APPLIED', {
        resultingVersion: snapshot.version,
        ...(runId ? { runId } : {}),
      });

      return { snapshot, limits };
    } catch (cause) {
      /* The request stays on the record as not applied, which is the useful fact. */
      await this.documents.closeCorrection(correctionId, 'NOT_APPLIED', {});
      throw cause;
    }
  }

  /* ------------------------------------------------------------ internals */

  /** Prose for each section, one task per section. */
  private async writeSections(
    context: DocumentContext,
    upstream: UpstreamSnapshot,
    deterministic: ComposedContent,
    model: string,
    instruction?: string,
  ): Promise<{ content: ComposedContent; outputCharacters: number }> {
    const provider = this.provider;

    if (!provider) {
      return { content: deterministic, outputCharacters: 0 };
    }

    const profile = resolveModelProfile(this.config);
    const plan = await this.plan(context, upstream, model);
    const sections: ComposedSection[] = [];
    let outputCharacters = 0;

    for (const composed of deterministic.sections) {
      const planned = plan?.sections.find((entry) => entry.key === composed.key);

      /*
       * A section the plan says has no evidence stays empty, with its reason. The
       * model is not asked to write it — asking would invite exactly the filler
       * the deterministic composer refused to produce.
       */
      if (composed.omittedReason || planned?.hasEvidence === false) {
        sections.push(composed);
        continue;
      }

      const requirements = this.requirementsForKeys(upstream, composed.references);

      if (requirements.length === 0) {
        sections.push(composed);
        continue;
      }

      const outcome = await this.runner.run(provider, {
        taskId: 'document.section',
        profile,
        model,
        evidence: [
          ...requirements.map((requirement) => ({
            blockId: requirement.key,
            text: `${requirement.title}\n${requirement.statement}`,
          })),
          ...(instruction
            ? [
                {
                  blockId: 'user-correction',
                  text: `A note from the person reviewing this document about how they would like it worded. ${EVIDENCE_NOTICE}\n\n${instruction}`,
                },
              ]
            : []),
        ],
        priorResults: this.sectionBrief(composed.key),
        schema: documentSectionOutputSchema,
        semantic: this.citationValidator(requirements.map((requirement) => requirement.key)),
        correlationId: context.correlationId,
        chunkId: composed.key,
      });

      if (!outcome.ok) {
        sections.push(composed);
        continue;
      }

      outputCharacters += outcome.value.body.length;

      sections.push({
        ...composed,
        body: outcome.value.body,
        /*
         * References stay as the application computed them. A model listing
         * fewer ids does not remove a requirement from the section's provenance,
         * and one listing more has already failed the citation check.
         */
      });
    }

    return { content: { sections, features: [], rows: [] }, outputCharacters };
  }

  /**
   * Feature rows: the model names them, the estimate prices them.
   *
   * Its output is joined to the deterministic rows on requirement id. A row it
   * proposes for requirements with no estimate unit behind them is dropped — that
   * would be a feature with no hours, which is scope with no price.
   */
  private async writeFeatures(
    context: DocumentContext,
    upstream: UpstreamSnapshot,
    deterministic: ComposedContent,
    model: string,
    instruction?: string,
  ): Promise<{ content: ComposedContent; outputCharacters: number }> {
    const provider = this.provider;

    if (!provider || deterministic.features.length === 0) {
      return { content: deterministic, outputCharacters: 0 };
    }

    const profile = resolveModelProfile(this.config);
    const known = new Set(upstream.context.requirements.map((requirement) => requirement.key));

    const outcome = await this.runner.run(provider, {
      taskId: 'document.features',
      profile,
      model,
      evidence: [
        ...upstream.context.requirements.map((requirement) => ({
          blockId: requirement.key,
          text: `${requirement.title}\n${requirement.statement}`,
        })),
        ...(instruction
          ? [
              {
                blockId: 'user-correction',
                text: `A note from the person reviewing this document about how they would like these features worded. ${EVIDENCE_NOTICE}\n\n${instruction}`,
              },
            ]
          : []),
      ],
      priorResults: [
        `Project type: ${upstream.context.projectTypes.join(', ') || 'unspecified'}`,
        `This project ${this.hasInterface(upstream) ? 'has a user interface' : 'has no user interface, so every Screen must be empty'}.`,
      ].join('\n'),
      schema: documentFeaturesSchema,
      semantic: {
        validate: (value) =>
          value.features
            .flatMap((feature) => feature.requirementIds)
            .filter((id) => !known.has(id))
            .map((id) => ({
              path: `features.${id}`,
              message: `"${id}" is not a requirement you were given.`,
              reason: 'hallucinated_source_reference' as const,
            })),
      },
      correlationId: context.correlationId,
    });

    if (!outcome.ok) {
      return { content: deterministic, outputCharacters: 0 };
    }

    const features = deterministic.features.map((row) => {
      const named = outcome.value.features.find((candidate) =>
        candidate.requirementIds.some((id) => row.requirementIds.includes(id)),
      );

      if (!named) {
        return row;
      }

      return {
        ...row,
        module: named.module,
        submodule: named.submodule,
        /* Never a screen on a project with no interface, whatever it returned. */
        screen: this.hasInterface(upstream) ? named.screen : '',
        description: named.description.includes('|')
          ? named.description
          : joinDetailPoints([named.description]),
        /* Hours, units and technologies are untouched: they came from the estimate. */
        totalHours: featureTotalHours(row.effort),
      };
    });

    return {
      content: { sections: [], features, rows: [] },
      outputCharacters: outcome.value.features.reduce(
        (total, feature) => total + feature.description.length,
        0,
      ),
    };
  }

  /** Which sections have evidence. Advisory; the template is fixed either way. */
  private async plan(
    context: DocumentContext,
    upstream: UpstreamSnapshot,
    model: string,
  ): Promise<{ sections: { key: string; hasEvidence: boolean }[] } | null> {
    const provider = this.provider;

    if (!provider) {
      return null;
    }

    const templateKeys = new Set(UNDERSTANDING_SECTIONS.map((section) => section.key));

    const outcome = await this.runner.run(provider, {
      taskId: 'document.plan',
      profile: resolveModelProfile(this.config),
      model,
      evidence: upstream.context.requirements.map((requirement) => ({
        blockId: requirement.key,
        text: `${requirement.title}\n${requirement.statement}`,
      })),
      priorResults: UNDERSTANDING_SECTIONS.map(
        (section) => `${section.key}: ${section.title} — ${section.guidance}`,
      ).join('\n'),
      schema: documentPlanSchema,
      semantic: {
        validate: (value) =>
          value.sections
            .filter((section) => !templateKeys.has(section.key))
            .map((section) => ({
              path: `sections.${section.key}`,
              message: `"${section.key}" is not a section of this document.`,
              reason: 'unsupported_category' as const,
            })),
      },
      correlationId: context.correlationId,
    });

    return outcome.ok ? outcome.value : null;
  }

  /** The section's heading and guidance. An application fact, not evidence. */
  private sectionBrief(key: string): string {
    const definition = understandingSection(key);

    if (!definition) {
      return '';
    }

    return [
      `Section heading: ${definition.title}`,
      `What belongs here: ${definition.guidance}`,
      'Write only this section. Do not write a heading, and do not write any other section.',
    ].join('\n');
  }

  /** Rejects any requirement id the run was not given. */
  private citationValidator(known: readonly string[]): SemanticValidator<DocumentSectionOutput> {
    const allowed = new Set(known);

    return {
      validate: (value) =>
        value.requirementIds
          .filter((id) => !allowed.has(id))
          .map((id) => ({
            path: `requirementIds.${id}`,
            message: `"${id}" is not a requirement you were given.`,
            reason: 'hallucinated_source_reference' as const,
          })),
    };
  }

  private requirementsForKeys(
    upstream: UpstreamSnapshot,
    references: readonly { readonly id: string }[],
  ): readonly RequirementItem[] {
    const wanted = new Set(references.map((reference) => reference.id));

    return upstream.context.requirements.filter((requirement) => wanted.has(requirement.key));
  }

  private hasInterface(upstream: UpstreamSnapshot): boolean {
    return upstream.context.projectTypes.some((type) =>
      /WEB|MOBILE|DESKTOP|PORTAL|DASHBOARD/i.test(type),
    );
  }

  private modelName(): string {
    const profile = resolveModelProfile(this.config);

    return this.config.ai.modelOverride.trim() || profile.model;
  }

  private evidenceSize(upstream: UpstreamSnapshot): number {
    return upstream.context.requirements.reduce(
      (total, requirement) => total + requirement.title.length + requirement.statement.length,
      0,
    );
  }
  /* ------------------------------------------------- Phase 8: rows */

  /**
   * Rewrite the wording of selected rows.
   *
   * The model supplies wording; the engine decides what may change. For an
   * acceptance criterion that is the condition's words — never which feature or
   * requirement it is about, because that is a scope decision. For an assumption it
   * is the statement and its impact wording — never the status or the provenance,
   * because those are what make it authoritative.
   */
  async regenerateRows(
    context: DocumentContext,
    type: DocumentType,
    selection: { readonly rowIds?: readonly string[]; readonly group?: string },
    request: {
      readonly useAi: boolean;
      readonly instruction?: string;
      readonly expectedVersion: number;
    },
  ): Promise<DocumentSnapshot> {
    if (request.useAi && !this.provider) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATION_NOT_CONFIGURED, 503);
    }

    const upstream = await this.documents.readUpstream(context);
    const runId = DocumentsRepository.newId('drun');
    const taskId: AiTaskId =
      type === 'ACCEPTANCE_CRITERIA'
        ? 'acceptance_criteria.regenerate'
        : type === 'WORK_BREAKDOWN_STRUCTURE'
          ? 'wbs.tasks.regenerate'
          : type === 'CLIENT_DEPENDENCY_SHEET'
            ? 'client_dependencies.suggest'
            : 'assumptions.suggest';

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      type,
      kind: 'SECTION_REGENERATION',
      status: 'RUNNING',
      provider: request.useAi && this.provider ? this.provider.name : 'none',
      modelName: request.useAi ? this.modelName() : 'none',
      promptVersions: request.useAi ? { [taskId]: 'v1' } : {},
      sectionKeys: selection.group ? [selection.group] : [...(selection.rowIds ?? [])],
      startedAt: new Date(),
      deterministicOnly: !request.useAi,
    });

    const named = new Map<string, Record<string, unknown>>();

    if (request.useAi && this.provider && type === 'ACCEPTANCE_CRITERIA') {
      const document = await this.documents.read(context, type);
      const selected = document.rows.filter((row) =>
        selection.rowIds ? selection.rowIds.includes(row.rowId) : true,
      );

      const known = new Set(upstream.context.requirements.map((requirement) => requirement.key));
      const features = new Set(
        (upstream.context.documents.featureListing?.features ?? []).map(
          (feature) => feature.featureId,
        ),
      );

      const outcome = await this.runner.run(this.provider, {
        taskId: 'acceptance_criteria.regenerate',
        profile: resolveModelProfile(this.config),
        model: this.modelName(),
        evidence: [
          ...upstream.context.requirements.map((requirement) => ({
            blockId: requirement.key,
            text: `${requirement.title}\n${requirement.statement}`,
          })),
          ...selected.map((row) => ({
            blockId: payloadText(row.payload, 'criterionKey') || row.rowId,
            text: JSON.stringify(row.payload),
          })),
          ...(request.instruction
            ? [
                {
                  blockId: 'user-correction',
                  text: `A note from the person reviewing this document about how they would like these conditions worded. ${EVIDENCE_NOTICE}\n\n${request.instruction}`,
                },
              ]
            : []),
        ],
        priorResults: [
          'Return wording only. Do not change which feature or requirement a condition is about.',
          'No figures and no standards. If the requirements do not state it, it does not exist.',
        ].join('\n'),
        schema: acceptanceCriteriaOutputSchema,
        semantic: {
          validate: (value) => [
            ...value.criteria
              .flatMap((criterion) => criterion.requirementIds)
              .filter((id) => !known.has(id))
              .map((id) => ({
                path: `criteria.${id}`,
                message: `"${id}" is not a requirement you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
            ...value.criteria
              .map((criterion) => criterion.featureId)
              .filter((id) => !features.has(id))
              .map((id) => ({
                path: `criteria.${id}`,
                message: `"${id}" is not a feature you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
          ],
        },
        correlationId: context.correlationId,
      });

      if (outcome.ok) {
        /*
         * Matched to the row by the feature it is about. A suggestion for a row the
         * user did not select is discarded rather than applied — a targeted rewrite
         * that quietly touched its neighbours would not be targeted.
         */
        for (const criterion of outcome.value.criteria) {
          const row = selected.find((candidate) =>
            (
              (candidate.payload as Record<string, unknown>).featureIds as string[] | undefined
            )?.includes(criterion.featureId),
          );

          if (row) {
            named.set(row.rowId, {
              given: criterion.given,
              when: criterion.when,
              then: criterion.then,
              rule: criterion.rule,
            });
          }
        }
      }
    }

    /*
     * The work breakdown, reworded. Only the four wording fields come back, and
     * `rewritableFields` discards anything else even if the model returns it — so a
     * rewrite cannot move a task, change its hours or touch its schedule.
     */
    if (request.useAi && this.provider && type === 'WORK_BREAKDOWN_STRUCTURE') {
      const document = await this.documents.read(context, type);
      const selected = document.rows.filter((row) =>
        selection.rowIds ? selection.rowIds.includes(row.rowId) : true,
      );

      const units = new Set(upstream.context.estimateUnits.map((unit) => unit.id));

      const outcome = await this.runner.run(this.provider, {
        taskId: 'wbs.tasks.regenerate',
        profile: resolveModelProfile(this.config),
        model: this.modelName(),
        evidence: [
          ...upstream.context.requirements.map((requirement) => ({
            blockId: requirement.key,
            text: `${requirement.title}\n${requirement.statement}`,
          })),
          ...selected.map((row) => ({
            blockId: payloadText(row.payload, 'wbsId') || row.rowId,
            text: JSON.stringify(row.payload),
          })),
          ...(request.instruction
            ? [
                {
                  blockId: 'user-correction',
                  text: `A note from the person reviewing this breakdown about how they would like the work described. ${EVIDENCE_NOTICE}\n\n${request.instruction}`,
                },
              ]
            : []),
        ],
        priorResults: [
          'Return wording only: what the task is called, what it involves, what it produces.',
          'The hours, the days and the critical path come from an approved estimate. Do not restate them.',
          'Do not move work between features or modules. Describing it is the whole task.',
        ].join('\n'),
        schema: wbsTasksOutputSchema,
        semantic: {
          validate: (value) =>
            value.tasks
              .map((task) => task.estimateUnitId)
              .filter((id) => !units.has(id))
              .map((id) => ({
                path: `tasks.${id}`,
                message: `"${id}" is not an estimate item you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
        },
        correlationId: context.correlationId,
      });

      if (outcome.ok) {
        for (const task of outcome.value.tasks) {
          const row = selected.find((candidate) =>
            (
              (candidate.payload as Record<string, unknown>).estimateUnitIds as string[] | undefined
            )?.includes(task.estimateUnitId),
          );

          if (row) {
            named.set(row.rowId, {
              task: task.task,
              description: task.description,
              deliverable: task.deliverable,
            });
          }
        }
      }
    }

    /*
     * The dependency sheet, reworded. The same shape of restriction, and one more
     * that matters here: nothing the model returns can set an owner, a date or a
     * status, so a rewrite cannot declare the project unblocked.
     */
    if (request.useAi && this.provider && type === 'CLIENT_DEPENDENCY_SHEET') {
      const document = await this.documents.read(context, type);
      const selected = document.rows.filter((row) =>
        selection.rowIds ? selection.rowIds.includes(row.rowId) : true,
      );

      const known = new Set(upstream.context.requirements.map((requirement) => requirement.key));

      const outcome = await this.runner.run(this.provider, {
        taskId: 'client_dependencies.suggest',
        profile: resolveModelProfile(this.config),
        model: this.modelName(),
        evidence: [
          ...upstream.context.requirements.map((requirement) => ({
            blockId: requirement.key,
            text: `${requirement.title}\n${requirement.statement}`,
          })),
          ...selected.map((row) => ({
            blockId: payloadText(row.payload, 'dependencyKey') || row.rowId,
            text: JSON.stringify(row.payload),
          })),
          ...(request.instruction
            ? [
                {
                  blockId: 'user-correction',
                  text: `A note from the person reviewing this sheet about how they would like these requests worded. ${EVIDENCE_NOTICE}\n\n${request.instruction}`,
                },
              ]
            : []),
        ],
        priorResults: [
          'Name something specific the client can hand over. "All required information" is not a dependency.',
          'Never include a credential, key, token or password value. Say what is needed, not what it is.',
          'Do not name a person, a date or a status. Those are decisions somebody else records.',
        ].join('\n'),
        schema: clientDependenciesOutputSchema,
        semantic: {
          validate: (value) => [
            ...value.dependencies
              .flatMap((dependency) => dependency.requirementKeys)
              .filter((key) => !known.has(key))
              .map((key) => ({
                path: `dependencies.${key}`,
                message: `"${key}" is not a requirement you were given.`,
                reason: 'hallucinated_source_reference' as const,
              })),
            /*
             * A model that returns a credential is refused at the schema boundary, not
             * merely warned about. The write path refuses it too; this catches it a
             * step earlier so the run records why it failed.
             */
            ...value.dependencies
              .filter((dependency) =>
                [
                  dependency.dependency,
                  dependency.description,
                  dependency.purpose,
                  dependency.expectedFormat,
                ].some((text) => looksLikeSecret(text).length > 0),
              )
              .map((dependency) => ({
                path: `dependencies.${dependency.category}`,
                message:
                  'This looks like an actual credential. Describe what is needed, never its value.',
                reason: 'disallowed_content' as const,
              })),
            ...value.dependencies
              .filter((dependency) => isTooVague(dependency.dependency))
              .map((dependency) => ({
                path: `dependencies.${dependency.category}`,
                message: `"${dependency.dependency}" is too vague for anybody to act on or close.`,
                reason: 'disallowed_content' as const,
              })),
          ],
        },
        correlationId: context.correlationId,
      });

      if (outcome.ok) {
        /* Matched by category and existing wording, so a rewrite stays on its row. */
        for (const dependency of outcome.value.dependencies) {
          const row = selected.find(
            (candidate) =>
              (candidate.payload as Record<string, unknown>).category === dependency.category,
          );

          if (row) {
            named.set(row.rowId, {
              dependency: dependency.dependency,
              description: dependency.description,
              purpose: dependency.purpose,
              expectedFormat: dependency.expectedFormat,
              impactIfDelayed: dependency.impactIfDelayed,
            });
          }
        }
      }
    }

    const snapshot = await this.documents.regenerateRows(
      context,
      type,
      selection,
      request.expectedVersion,
      named,
      request.instruction,
    );

    await this.repository.finishRun(runId, { status: 'COMPLETED', completedAt: new Date() });

    return snapshot;
  }

  /**
   * Ask a model what the plan appears to be resting on.
   *
   * Everything it returns is stored as a **candidate**: `DRAFT`, provenance
   * `MODEL_SUGGESTED`, excluded from an approved document until a person confirms
   * it. `candidateToAssumption` is the only path from the model's answer to a row,
   * and it is the function that supplies every authoritative field — the model has
   * nowhere to put one.
   */
  async suggestAssumptions(
    context: DocumentContext,
    type: DocumentType,
    request: { readonly useAi: boolean; readonly expectedVersion: number },
  ): Promise<DocumentSnapshot> {
    if (type !== 'ASSUMPTIONS') {
      throw new DocumentError(DOCUMENT_ERROR_CODES.WRONG_DOCUMENT_SHAPE, 422);
    }

    if (!request.useAi || !this.provider) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATION_NOT_CONFIGURED, 503);
    }

    const upstream = await this.documents.readUpstream(context);
    const runId = DocumentsRepository.newId('drun');

    await this.repository.createRun({
      runId,
      projectId: context.projectId,
      type,
      kind: 'FULL_GENERATION',
      status: 'RUNNING',
      provider: this.provider.name,
      modelName: this.modelName(),
      promptVersions: { 'assumptions.suggest': 'v1' },
      sectionKeys: [],
      startedAt: new Date(),
      deterministicOnly: false,
    });

    const known = new Map(
      upstream.context.requirements.map((requirement) => [requirement.key, requirement.id]),
    );

    const outcome = await this.runner.run(this.provider, {
      taskId: 'assumptions.suggest',
      profile: resolveModelProfile(this.config),
      model: this.modelName(),
      evidence: upstream.context.requirements.map((requirement) => ({
        blockId: requirement.key,
        text: `${requirement.title}\n${requirement.statement}`,
      })),
      priorResults: [
        `Project type: ${upstream.context.projectTypes.join(', ') || 'unspecified'}`,
        'Everything you return is a candidate for a person to accept or reject.',
        'A missing answer is not an assumption. Say what would have to be true.',
      ].join('\n'),
      schema: assumptionCandidatesOutputSchema,
      semantic: {
        validate: (value) =>
          value.assumptions
            .flatMap((assumption) => assumption.requirementKeys)
            .filter((key) => !known.has(key))
            .map((key) => ({
              path: `assumptions.${key}`,
              message: `"${key}" is not a requirement you were given.`,
              reason: 'hallucinated_source_reference' as const,
            })),
      },
      correlationId: context.correlationId,
    });

    if (!outcome.ok) {
      await this.repository.finishRun(runId, {
        status: 'FAILED',
        completedAt: new Date(),
        failureReason: outcome.reason,
      });

      throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_GENERATION_FAILED, 422);
    }

    const snapshot = await this.documents.addAssumptionCandidates(
      context,
      type,
      outcome.value.assumptions,
      request.expectedVersion,
      runId,
    );

    await this.repository.finishRun(runId, { status: 'COMPLETED', completedAt: new Date() });

    return snapshot;
  }
}

/** Sections whose prose a person has taken over. Reported, never rewritten. */
export function protectedSectionKeys(
  sections: readonly { readonly key: string; readonly origin: string }[],
): readonly string[] {
  return sections
    .filter((section) => isSectionProtected(section.origin as never))
    .map((section) => section.key);
}

/** Row identity for joining model output to priced rows. */
export function rowKey(row: Pick<FeatureRow, 'estimateUnitIds'>): string {
  return row.estimateUnitIds.join('|');
}
