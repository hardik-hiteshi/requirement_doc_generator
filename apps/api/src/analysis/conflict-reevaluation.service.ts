import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  evaluateConflictAgainstClarification,
  type ConflictReevaluation,
  type ConflictStatus,
  type ReevaluationFacts,
} from '@wdrg/contracts';

import { AppConfigService } from '../config/app-config.service';
import { AI_PROVIDER_PORT } from '../ports';
import { AnalysisRepository } from './analysis.repository';
import { resolveModelProfile } from './models/resolve-profile';
import { conflictReevaluationOutputSchema } from './pipeline/task-schemas';
import type { InferenceProvider } from './providers/inference.types';
import { AiTaskRunner } from './task-runner.service';
import type { AnalysisFindingDocument, ClarificationDocument } from './schemas/analysis.schema';

/**
 * Re-checking the contradictions a confirmed clarification touched.
 *
 * A conflict is two client statements that cannot both be true. When a
 * confirmed answer changes one of those statements, the conflict may no longer
 * exist — and leaving it blocking would make the client answer a question and
 * watch nothing happen. Equally, an answer that changes the wording without
 * settling the disagreement must leave it blocking, because the contradiction
 * is still there.
 *
 * ## Targeted, never a re-analysis
 *
 * Only conflicts in scope are looked at: those holding a requirement the answer
 * changed, those sharing a requirement with one, and those linked to the
 * clarification directly. A project with three hundred conflicts and one
 * clarification re-checks the two it touched.
 *
 * ## Deterministic rules decide; the model may only withhold
 *
 * Six conditions, in `evaluateConflictAgainstClarification`. Five are facts
 * about stored data. The sixth asks the model whether the answer addresses what
 * the two statements disagreed about — a question about meaning that nothing
 * else here can answer — and it is a **veto**: a `false` stops a resolution the
 * other five would have allowed, and a `true` can never supply a missing one.
 * The model's confidence is not consulted, and there is nowhere for it to be.
 *
 * ## Nothing is ever overwritten
 *
 * Every re-evaluation writes an immutable snapshot of the conflict as it was
 * first, then appends a record of what was decided and why — including when
 * nothing changed. "We looked at this again after Q-004 and it is still a
 * contradiction" is exactly as much a fact worth keeping as a resolution.
 */
@Injectable()
export class ConflictReevaluator {
  private readonly logger = new Logger(ConflictReevaluator.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly repository: AnalysisRepository,
    private readonly runner: AiTaskRunner,
    @Optional()
    @Inject(AI_PROVIDER_PORT)
    private readonly provider: InferenceProvider | null,
  ) {}

  /**
   * Re-evaluates every conflict the clarification could have affected.
   *
   * Returns what it decided, so the caller can audit it and the UI can explain
   * it. Conflicts out of scope are not touched at all — not even to record that
   * they were considered, because they were not.
   */
  async reevaluate(input: ReevaluationInput): Promise<ConflictReevaluation[]> {
    const conflicts = await this.inScope(input);

    if (conflicts.length === 0) {
      return [];
    }

    const agreement = await this.askModel(input, conflicts);
    const now = new Date();
    const records: ConflictReevaluation[] = [];

    for (const conflict of conflicts) {
      /*
       * A conflict a *person* settled is left alone. Somebody chose, rewrote or
       * accepted the risk, and a clarification arriving afterwards does not undo
       * their decision — it may be a reason to look again, but that is theirs.
       *
       * A conflict *this mechanism* settled is re-evaluated, because it was
       * settled on the strength of an answer that may since have changed. The
       * distinction is the whole point: protect human decisions, revisit
       * automatic ones when their basis moves.
       */
      if (HUMAN_SETTLED_STATUSES.includes(conflict.status as ConflictStatus)) {
        continue;
      }

      const payload = conflict.payload as { positions?: { itemId: string }[] };
      const positionItemIds = (payload.positions ?? []).map((position) => position.itemId);

      const facts: ReevaluationFacts = {
        answerConfirmed: input.answerConfirmed,
        isAssumption: input.isAssumption,
        linkedItemIds: conflict.itemIds.filter((itemId) => input.linkedItemIds.includes(itemId)),
        positionItemIds,
        appliedItemIds: positionItemIds.filter((itemId) => input.appliedItemIds.includes(itemId)),
        proposedItemIds: positionItemIds.filter((itemId) => input.proposedItemIds.includes(itemId)),
        // Absent agreement is not agreement: a model that failed, timed out or
        // was never asked cannot have agreed to anything.
        semanticAgreement: agreement.get(conflict.findingId) === true,
      };

      const outcome = evaluateConflictAgainstClarification(facts);

      if (outcome.status === conflict.status) {
        // Unchanged, and recorded anyway when the clarification reached it —
        // "still a contradiction after Q-004" is an audit fact.
        if (facts.linkedItemIds.length === 0 && facts.appliedItemIds.length === 0) {
          continue;
        }
      }

      const previousVersion = conflict.version;

      // The snapshot comes before the change, always. It is the answer to
      // "what was conflicting before the clarification?"
      await this.repository.recordConflictVersion({
        conflictId: conflict.findingId,
        projectId: input.projectId,
        version: previousVersion,
        status: conflict.status,
        severity: conflict.severity ?? 'major',
        kind: conflict.kind ?? 'contradiction',
        summary: (conflict.payload as { summary?: string }).summary ?? '',
        itemIds: [...conflict.itemIds],
        positions: (conflict.payload as { positions?: Record<string, unknown>[] }).positions ?? [],
        changedBy: 'clarification_reevaluation',
        clarificationKey: input.clarificationKey,
        rationale: outcome.rationale,
        recordedAt: now,
      });

      const record: ConflictReevaluation = {
        clarificationId: input.clarificationId,
        clarificationKey: input.clarificationKey,
        answerVersion: input.answerVersion,
        affectedItemIds: [...new Set([...facts.appliedItemIds, ...facts.proposedItemIds])],
        previousStatus: conflict.status as ConflictStatus,
        resultingStatus: outcome.status,
        previousVersion,
        resultingVersion: previousVersion + 1,
        conditionsMet: [...outcome.conditionsMet],
        conditionsFailed: [...outcome.conditionsFailed],
        rationale: outcome.rationale,
        evaluatedAt: now.toISOString(),
      };

      const updated = await this.repository.updateFinding(
        input.projectId,
        conflict.findingId,
        previousVersion,
        {
          status: outcome.status,
          // Blocking severity never changes here. Whether it blocks is decided
          // by the status; downgrading severity would hide a contradiction
          // rather than settle it.
          reevaluations: [
            ...(((conflict.reevaluations ?? []) as unknown as ConflictReevaluation[]) ?? []),
            record,
          ],
        },
      );

      if (!updated) {
        this.logger.warn(
          { conflictId: conflict.findingId, correlationId: input.correlationId },
          'Conflict changed while being re-evaluated; leaving it as it is',
        );

        continue;
      }

      records.push(record);
    }

    return records;
  }

  /**
   * The conflicts a clarification could have affected.
   *
   * Three ways in, and the second is the one that matters: a conflict is
   * between two requirements, and changing either of them changes the conflict
   * — even if the question was only ever filed against one side.
   */
  private async inScope(input: ReevaluationInput): Promise<AnalysisFindingDocument[]> {
    const touched = new Set([
      ...input.appliedItemIds,
      ...input.proposedItemIds,
      ...input.linkedItemIds,
    ]);

    if (touched.size === 0 && input.linkedFindingIds.length === 0) {
      return [];
    }

    const conflicts = await this.repository.listFindings(input.projectId, 'conflict');

    return conflicts.filter(
      (conflict) =>
        conflict.itemIds.some((itemId) => touched.has(itemId)) ||
        input.linkedFindingIds.includes(conflict.findingId),
    );
  }

  /**
   * Asks the model whether the answer settles each contradiction.
   *
   * Returns an empty map on any failure, which the caller reads as "did not
   * agree" — the safe direction. An inference problem must never be able to
   * clear a blocker.
   */
  private async askModel(
    input: ReevaluationInput,
    conflicts: readonly AnalysisFindingDocument[],
  ): Promise<Map<string, boolean>> {
    const provider = this.provider;

    if (!provider) {
      return new Map();
    }

    const profile = resolveModelProfile(this.config);
    const model = this.config.ai.modelOverride.trim() || profile.model;
    const known = new Set(conflicts.map((conflict) => conflict.findingId));

    const outcome = await this.runner.run(provider, {
      taskId: 'conflict.reevaluate',
      profile,
      model,
      evidence: [
        {
          blockId: input.clarificationKey,
          text: `Question: ${input.question}\nConfirmed answer: ${input.answerText}`,
        },
        ...conflicts.map((conflict) => ({
          blockId: conflict.findingId,
          text: describeConflict(conflict),
        })),
      ],
      schema: conflictReevaluationOutputSchema,
      semantic: {
        validate: (value) =>
          value.evaluations
            .filter((evaluation) => !known.has(evaluation.conflictId))
            .map((evaluation) => ({
              path: `evaluations.${evaluation.conflictId}`,
              message: `"${evaluation.conflictId}" is not one of the conflicts you were given.`,
              reason: 'hallucinated_source_reference' as const,
            })),
      },
      correlationId: input.correlationId,
    });

    if (!outcome.ok) {
      this.logger.warn(
        { correlationId: input.correlationId, reason: outcome.reason },
        'Could not check whether the answer settles these conflicts; treating them as unsettled',
      );

      return new Map();
    }

    return new Map(
      outcome.value.evaluations.map((evaluation) => [evaluation.conflictId, evaluation.settled]),
    );
  }
}

/** The conflict, as the model needs to see it: both sides, quoted. */
function describeConflict(conflict: AnalysisFindingDocument): string {
  const payload = conflict.payload as {
    summary?: string;
    positions?: { statement: string; sourceName?: string }[];
  };

  const positions = (payload.positions ?? [])
    .map(
      (position, index) =>
        `Position ${index + 1}${position.sourceName ? ` (${position.sourceName})` : ''}: ${position.statement}`,
    )
    .join('\n');

  return `Contradiction: ${payload.summary ?? ''}\n${positions}`;
}

/**
 * Conflict states a person put there, which re-evaluation must not disturb.
 *
 * `resolved_by_clarification` is deliberately absent: it was reached
 * automatically, so it is revisited automatically when the answer behind it
 * changes.
 */
const HUMAN_SETTLED_STATUSES: readonly ConflictStatus[] = [
  'resolved',
  'dismissed',
  'accepted_risk',
  'superseded',
];

export interface ReevaluationInput {
  readonly projectId: string;
  readonly correlationId: string;
  readonly clarificationId: string;
  readonly clarificationKey: string;
  readonly question: string;
  readonly answerText: string;
  readonly answerVersion: number;
  readonly answerConfirmed: boolean;
  readonly isAssumption: boolean;
  /** Requirements the clarification is linked to. */
  readonly linkedItemIds: readonly string[];
  /** Findings the clarification is linked to. */
  readonly linkedFindingIds: readonly string[];
  /** Requirements the integration changed and applied. */
  readonly appliedItemIds: readonly string[];
  /** Requirements with a revision still waiting for a person. */
  readonly proposedItemIds: readonly string[];
}

/** Everything a caller needs to re-evaluate after an answer is confirmed. */
export function reevaluationInputFrom(
  clarification: ClarificationDocument,
  input: {
    projectId: string;
    correlationId: string;
    answerText: string;
    answerVersion: number;
    answerConfirmed: boolean;
    isAssumption: boolean;
    appliedItemIds: readonly string[];
    proposedItemIds: readonly string[];
  },
): ReevaluationInput {
  return {
    projectId: input.projectId,
    correlationId: input.correlationId,
    clarificationId: clarification.clarificationId,
    clarificationKey: clarification.key,
    question: clarification.question,
    answerText: input.answerText,
    answerVersion: input.answerVersion,
    answerConfirmed: input.answerConfirmed,
    isAssumption: input.isAssumption,
    linkedItemIds: clarification.relatedItemIds,
    linkedFindingIds: [...clarification.relatedConflictIds, ...clarification.relatedFindingIds],
    appliedItemIds: input.appliedItemIds,
    proposedItemIds: input.proposedItemIds,
  };
}
