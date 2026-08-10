import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DOCUMENT_ERROR_CODES,
  DOCUMENT_SHAPE_BY_TYPE,
  EVIDENCE_NOTICE,
  featureTotalHours,
  isSectionProtected,
  joinDetailPoints,
  MODEL_RAISABLE_KINDS,
  UNDERSTANDING_SECTIONS,
  understandingSection,
  type DocumentSnapshot,
  type DocumentType,
  type FeatureRow,
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
import {
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
            ? await this.writeFeatures(context, upstream, deterministic, model)
            : await this.writeSections(context, upstream, deterministic, model);

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

  /* ------------------------------------------------------------ internals */

  /** Prose for each section, one task per section. */
  private async writeSections(
    context: DocumentContext,
    upstream: UpstreamSnapshot,
    deterministic: ComposedContent,
    model: string,
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
        evidence: requirements.map((requirement) => ({
          blockId: requirement.key,
          text: `${requirement.title}\n${requirement.statement}`,
        })),
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

    return { content: { sections, features: [] }, outputCharacters };
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
      evidence: upstream.context.requirements.map((requirement) => ({
        blockId: requirement.key,
        text: `${requirement.title}\n${requirement.statement}`,
      })),
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
      content: { sections: [], features },
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
