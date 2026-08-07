import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  clarificationKey as formatClarificationKey,
  PROPOSAL_REASON_MESSAGES,
  type ClarificationStatus,
  type IntegrationImpact,
  type IntegrationResult,
  type ProposalReason,
  type RequirementItem,
} from '@wdrg/contracts';

import { AppConfigService } from '../config/app-config.service';
import { AI_PROVIDER_PORT } from '../ports';
import { AnalysisRepository } from './analysis.repository';
import { resolveModelProfile } from './models/resolve-profile';
import { integrateOutputSchema } from './pipeline/task-schemas';
import { clarificationLink } from './pipeline/evidence.service';
import type { InferenceProvider } from './providers/inference.types';
import { AiTaskRunner } from './task-runner.service';
import type { ClarificationDocument, RequirementItemDocument } from './schemas/analysis.schema';

/**
 * Folding a confirmed clarification answer back into the requirements.
 *
 * ## A confirmed answer is evidence, not an assumption
 *
 * Ask "which users can approve?", get "only Project Managers", and the
 * requirement that said *"Users can approve requests"* should come to say *"Only
 * Project Managers can approve requests"* — traced to the clarification, at full
 * evidence weight. Recording that as `Assumption: Project Managers can approve`
 * would understate what is known and invite a reader to discount a fact the
 * client confirmed. An assumption is created only when a person explicitly says
 * they are assuming.
 *
 * ## Targeted, not a re-run
 *
 * Only the requirements the answer actually touches are sent to the model —
 * those related to the question, plus those sharing a finding with it. Re-running
 * the whole project would take minutes on local hardware, would re-derive
 * hundreds of requirements nobody asked about, and would risk changing wording
 * that has nothing to do with the answer.
 *
 * ## Four preservation rules, and none of them are advisory
 *
 * | The requirement is… | What happens |
 * | --- | --- |
 * | AI-generated, never touched | Updated, with the previous version kept |
 * | AI-generated, manually edited | **Proposed**, never applied |
 * | Written by a person | **Proposed**, never applied |
 * | In an approved baseline | **Proposed**, and the baseline goes out of date |
 *
 * The three proposal cases exist because a person made a decision, and a model
 * does not get to undo one. What it may do is say "given this answer, I would
 * put it like this" and wait.
 */
@Injectable()
export class ClarificationIntegration {
  private readonly logger = new Logger(ClarificationIntegration.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly repository: AnalysisRepository,
    private readonly runner: AiTaskRunner,
    @Optional()
    @Inject(AI_PROVIDER_PORT)
    private readonly provider: InferenceProvider | null,
  ) {}

  /**
   * Applies a confirmed answer to the requirements it affects.
   *
   * Nothing is written until the model's output has validated. A failure leaves
   * the answer confirmed and every requirement exactly as it was — an
   * integration that half-succeeded would be worse than one that did not run.
   */
  async integrate(input: IntegrationInput): Promise<IntegrationResult> {
    const { clarification, answerVersion, answerText, projectId, correlationId } = input;
    const key = clarification.key;

    const affected = await this.affectedItems(projectId, clarification);

    if (affected.length === 0) {
      // Nothing to change is a legitimate outcome, not a failure: a question
      // about scope may be worth asking and touch no existing requirement.
      return {
        clarificationId: clarification.clarificationId,
        clarificationKey: key,
        answerVersion,
        status: 'INTEGRATED',
        impacts: [],
        resolvedFindingIds: [],
      };
    }

    const provider = this.provider;

    if (!provider) {
      return this.failed(clarification, answerVersion, 'Analysis is not configured.');
    }

    const profile = resolveModelProfile(this.config);
    const model = this.config.ai.modelOverride.trim() || profile.model;
    const knownIds = new Set(affected.map((item) => item.itemId));

    /*
     * The evidence is the question, the answer, and the affected requirements —
     * nothing else. A smaller prompt is a more accurate one here: the task is
     * "rewrite these few statements given this fact", and adding the rest of the
     * project invites the model to revisit requirements nobody asked about.
     */
    const outcome = await this.runner.run(provider, {
      taskId: 'clarification.integrate',
      profile,
      model,
      evidence: [
        {
          blockId: key,
          text: `Question: ${clarification.question}\nConfirmed answer: ${answerText}`,
        },
        ...affected.map((item) => ({
          blockId: item.itemId,
          text: `[${item.key}] (${item.category}) ${item.title}: ${item.statement}`,
        })),
      ],
      schema: integrateOutputSchema,
      semantic: {
        validate: (value) =>
          value.updates
            .filter((update) => !knownIds.has(update.itemId))
            .map((update) => ({
              path: `updates.${update.itemId}`,
              message: `"${update.itemId}" is not one of the requirements you were given.`,
              reason: 'hallucinated_source_reference' as const,
            })),
      },
      correlationId,
    });

    if (!outcome.ok) {
      this.logger.warn(
        { clarificationKey: key, reason: outcome.reason, correlationId },
        'Clarification integration failed; nothing was changed',
      );

      return this.failed(
        clarification,
        answerVersion,
        'The model could not produce a usable revision. Nothing was changed.',
      );
    }

    /*
     * New requirements the answer creates are deliberately ignored.
     *
     * The task's schema allows them, and a larger model will propose them. But a
     * requirement invented during integration has no source in any document and
     * no reviewer looking for it, and it would arrive in a baseline as though
     * the client had asked for it. If the answer implies a new requirement, a
     * person can add one — and it will be marked as theirs.
     */
    const byId = new Map(affected.map((item) => [item.itemId, item]));
    const impacts: IntegrationImpact[] = [];
    const now = new Date();
    let anyProposed = false;

    for (const update of outcome.value.updates) {
      const item = byId.get(update.itemId);

      if (!item) {
        continue;
      }

      if (normalise(update.description) === normalise(item.statement)) {
        impacts.push({
          itemId: item.itemId,
          itemKey: item.key,
          outcome: 'unchanged',
          before: item.statement,
          reason: 'The answer did not change this requirement.',
        });

        continue;
      }

      const guard = protectionFor(
        {
          id: item.itemId,
          origin: item.origin as RequirementItem['origin'],
          editedByUser: item.editedByUser,
          status: item.status as RequirementItem['status'],
        },
        input.approvedItemIds,
      );

      if (guard) {
        anyProposed = true;

        await this.repository.updateItem(input.projectId, item.itemId, item.version, {
          proposedRevision: {
            clarificationId: clarification.clarificationId,
            clarificationKey: key,
            currentStatement: item.statement,
            proposedStatement: update.description,
            reason: `Confirmed answer to ${key}: ${answerText}`.slice(0, 2_000),
            proposalReason: guard,
            proposedAt: now.toISOString(),
          },
        });

        impacts.push({
          itemId: item.itemId,
          itemKey: item.key,
          outcome: 'proposed',
          before: item.statement,
          after: update.description,
          reason: PROPOSAL_REASON_MESSAGES[guard],
          proposalReason: guard,
        });

        continue;
      }

      await this.applyUpdate({
        projectId: input.projectId,
        item,
        statement: update.description,
        clarificationId: clarification.clarificationId,
        clarificationKey: key,
        answerVersion,
        answerText,
        now,
      });

      impacts.push({
        itemId: item.itemId,
        itemKey: item.key,
        outcome: 'applied',
        before: item.statement,
        after: update.description,
        reason: `Updated from the confirmed answer to ${key}.`,
      });
    }

    /*
     * Findings the answer closed.
     *
     * Bounded twice over: the model may only name a finding, and the finding is
     * only closed if it is about a requirement this integration was given. A
     * model that decides an unrelated conflict is settled does not get to close
     * it, and a conflict is never closed this way at all — deciding that two
     * statements no longer contradict each other is a person's call.
     */
    const claimed = new Set(outcome.value.updates.flatMap((update) => update.resolvedFindingIds));
    const resolvedFindingIds: string[] = [];

    for (const findingId of claimed) {
      const finding = await this.repository.findFinding(input.projectId, findingId);
      const aboutAffected = finding?.itemIds.some((itemId) => knownIds.has(itemId)) ?? false;

      if (finding?.status === 'open' && finding.type !== 'conflict' && aboutAffected) {
        resolvedFindingIds.push(findingId);
        await this.repository.updateFinding(input.projectId, findingId, finding.version, {
          status: 'resolved',
          resolution: {
            note: `Resolved by the confirmed answer to ${key}.`,
            decidedAt: now.toISOString(),
          },
        });
      }
    }

    return {
      clarificationId: clarification.clarificationId,
      clarificationKey: key,
      answerVersion,
      // A single proposal is enough to need a person: the answer is not fully
      // reflected until somebody decides about it.
      status: anyProposed ? 'NEEDS_REVIEW' : 'INTEGRATED',
      impacts,
      resolvedFindingIds: [...new Set(resolvedFindingIds)],
    };
  }

  /**
   * Writes the new wording, keeping the old one.
   *
   * Also attaches the clarification as a traceability link, which is what makes
   * the requirement's evidence score reflect the fact that somebody confirmed
   * it — and what lets the UI show "Confirmed clarification Q-004" as its source.
   */
  private async applyUpdate(input: {
    projectId: string;
    item: RequirementItemDocument;
    statement: string;
    clarificationId: string;
    clarificationKey: string;
    answerVersion: number;
    answerText: string;
    now: Date;
  }): Promise<void> {
    const { item } = input;

    await this.repository.recordVersion({
      itemId: item.itemId,
      projectId: input.projectId,
      version: item.version,
      title: item.title,
      statement: item.statement,
      category: item.category,
      priority: item.priority,
      status: item.status,
      references: item.references,
      changedBy: 'clarification_integration',
      reason: `Confirmed answer to ${input.clarificationKey}.`,
      clarificationKey: input.clarificationKey,
      recordedAt: input.now,
    });

    const existing = item.references.filter(
      (reference) => (reference as { sourceId?: string }).sourceId !== input.clarificationId,
    );

    await this.repository.updateItem(input.projectId, item.itemId, item.version, {
      statement: input.statement,
      needsRevalidation: false,
      references: [
        ...existing,
        clarificationLink({
          clarificationId: input.clarificationId,
          clarificationKey: input.clarificationKey,
          answerVersion: input.answerVersion,
          text: input.answerText,
        }),
      ],
    });
  }

  /**
   * The requirements a clarification touches.
   *
   * Its own related items, plus anything sharing a finding with it — a question
   * raised about a conflict affects both sides of that conflict, not only the
   * one the question happened to be filed against.
   */
  private async affectedItems(
    projectId: string,
    clarification: ClarificationDocument,
  ): Promise<RequirementItemDocument[]> {
    const ids = new Set(clarification.relatedItemIds);

    for (const findingId of [
      ...clarification.relatedFindingIds,
      ...clarification.relatedConflictIds,
    ]) {
      const finding = await this.repository.findFinding(projectId, findingId);

      for (const itemId of finding?.itemIds ?? []) {
        ids.add(itemId);
      }
    }

    if (ids.size === 0) {
      return [];
    }

    const items = await this.repository.findItemsByIds(projectId, [...ids]);

    // Superseded and rejected requirements are not part of the baseline, so
    // rewriting them would change a record of a decision rather than a
    // requirement.
    return items.filter((item) => item.status !== 'superseded' && item.status !== 'rejected');
  }

  private failed(
    clarification: ClarificationDocument,
    answerVersion: number,
    reason: string,
  ): IntegrationResult {
    return {
      clarificationId: clarification.clarificationId,
      clarificationKey: clarification.key,
      answerVersion,
      status: 'FAILED',
      impacts: [],
      resolvedFindingIds: [],
      failureReason: reason,
    };
  }
}

export interface IntegrationInput {
  readonly projectId: string;
  readonly correlationId: string;
  readonly clarification: ClarificationDocument;
  readonly answerVersion: number;
  readonly answerText: string;
  /** Requirement ids named by an approved baseline. Those are never rewritten. */
  readonly approvedItemIds: ReadonlySet<string>;
}

/**
 * Whether this requirement is protected from automatic rewriting, and why.
 *
 * Returns `null` when the model may update it directly — an AI-generated
 * requirement nobody has touched. Everything else is a decision somebody made.
 */
export function protectionFor(
  item: Pick<RequirementItem, 'origin' | 'editedByUser' | 'status'> & {
    itemId?: string;
    id?: string;
  },
  approvedItemIds: ReadonlySet<string>,
): ProposalReason | null {
  const id = item.itemId ?? item.id ?? '';

  if (approvedItemIds.has(id)) {
    return 'already_approved';
  }

  if (item.origin === 'manual') {
    return 'user_created';
  }

  if (item.editedByUser) {
    return 'manually_edited';
  }

  if (item.status === 'accepted') {
    return 'accepted_by_user';
  }

  return null;
}

/** Wording differences that are only whitespace or punctuation are not changes. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export { formatClarificationKey };
export type { ClarificationStatus };
