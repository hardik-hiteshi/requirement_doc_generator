import {
  CLARIFICATION_RESOLUTION_CONDITIONS,
  RESOLUTION_CONDITION_LABELS,
  type ClarificationResolutionCondition,
  type ConflictStatus,
} from './findings.contract';

/**
 * Whether a confirmed clarification settles a conflict.
 *
 * The single most consequential automatic decision in this phase, and therefore
 * the one with the least room for judgement. A conflict is two client
 * statements that cannot both be true; marking one settled without cause hides
 * a contradiction inside a document somebody will sign.
 *
 * ## Deterministic rules decide. The model may only withhold.
 *
 * Six conditions, every one checked against stored records by the code below.
 * Five are facts about the data — was the answer confirmed, is it a client fact
 * rather than an assumption, is the question linked to the conflict, was every
 * contradicting requirement actually changed by it, are those changes applied
 * rather than sitting as proposals.
 *
 * The sixth asks the model whether the answer addresses what the two statements
 * disagreed about, because that is a question about meaning and nothing else
 * here can answer it. But it is a **veto, not a vote**: the model can only stop
 * a resolution the deterministic rules would otherwise allow. It can never
 * supply a missing condition, and its confidence is not consulted at all.
 *
 * Fail any condition and the conflict stays blocking — `still_conflicting` when
 * the answer did not reach it, `needs_review` when it reached it and did not
 * settle it. Both block approval, because an unsettled contradiction is
 * unsettled however it got that way.
 */

export interface ReevaluationFacts {
  /** The answer has been confirmed as the client's, not merely typed. */
  readonly answerConfirmed: boolean;
  /** It is a client fact. An assumption is not authoritative evidence. */
  readonly isAssumption: boolean;
  /** Requirement ids in this conflict that the clarification is linked to. */
  readonly linkedItemIds: readonly string[];
  /** Every requirement holding a position in this conflict. */
  readonly positionItemIds: readonly string[];
  /** Positions this integration changed and applied. */
  readonly appliedItemIds: readonly string[];
  /** Positions with a revision still waiting for a person. */
  readonly proposedItemIds: readonly string[];
  /**
   * Whether the model agreed the answer resolves the contradiction.
   *
   * `false` when it disagreed *or* when it was not asked — an unavailable
   * opinion is not agreement.
   */
  readonly semanticAgreement: boolean;
}

export interface ReevaluationOutcome {
  readonly status: ConflictStatus;
  readonly conditionsMet: readonly ClarificationResolutionCondition[];
  readonly conditionsFailed: readonly ClarificationResolutionCondition[];
  /** Plain language, for a reviewer and an auditor. Never model output. */
  readonly rationale: string;
}

export function evaluateConflictAgainstClarification(
  facts: ReevaluationFacts,
): ReevaluationOutcome {
  const holds: Record<ClarificationResolutionCondition, boolean> = {
    confirmed_answer: facts.answerConfirmed,
    authoritative_not_assumption: !facts.isAssumption,
    linked_to_conflict: facts.linkedItemIds.length > 0,
    all_positions_addressed:
      facts.positionItemIds.length > 0 &&
      facts.positionItemIds.every(
        (itemId) => facts.appliedItemIds.includes(itemId) || facts.proposedItemIds.includes(itemId),
      ),
    updates_applied:
      facts.positionItemIds.length > 0 &&
      facts.positionItemIds.every((itemId) => facts.appliedItemIds.includes(itemId)),
    semantic_agreement: facts.semanticAgreement,
  };

  const conditionsMet = CLARIFICATION_RESOLUTION_CONDITIONS.filter((condition) => holds[condition]);
  const conditionsFailed = CLARIFICATION_RESOLUTION_CONDITIONS.filter(
    (condition) => !holds[condition],
  );

  if (conditionsFailed.length === 0) {
    return {
      status: 'resolved_by_clarification',
      conditionsMet,
      conditionsFailed,
      rationale:
        'The confirmed answer updated every requirement in this conflict, and the updates are applied. It is no longer a contradiction.',
    };
  }

  /*
   * Untouched. The clarification is not linked here and changed nothing in it,
   * so this conflict is exactly as it was — and saying "still conflicting"
   * would imply somebody looked at the substance, which nobody did.
   */
  if (!holds.linked_to_conflict && facts.appliedItemIds.length === 0) {
    return {
      status: 'open',
      conditionsMet,
      conditionsFailed,
      rationale: 'This clarification does not touch either side of this conflict.',
    };
  }

  /*
   * The answer reached this conflict without settling it. That is a reviewer's
   * problem now — either it addressed one side and not the other, or the change
   * is waiting for somebody to accept, or the model does not think the answer
   * speaks to the disagreement.
   */
  if (holds.linked_to_conflict || facts.appliedItemIds.length > 0) {
    return {
      status: holds.all_positions_addressed ? 'needs_review' : 'still_conflicting',
      conditionsMet,
      conditionsFailed,
      rationale: describeFailure(conditionsFailed, facts),
    };
  }

  return {
    status: 'still_conflicting',
    conditionsMet,
    conditionsFailed,
    rationale: describeFailure(conditionsFailed, facts),
  };
}

function describeFailure(
  failed: readonly ClarificationResolutionCondition[],
  facts: ReevaluationFacts,
): string {
  const unaddressed = facts.positionItemIds.filter(
    (itemId) => !facts.appliedItemIds.includes(itemId) && !facts.proposedItemIds.includes(itemId),
  ).length;

  if (failed.includes('all_positions_addressed') && unaddressed > 0) {
    return `The answer changed part of this conflict but left ${unaddressed} contradicting ${unaddressed === 1 ? 'requirement' : 'requirements'} untouched, so the two still cannot both be true.`;
  }

  if (failed.includes('updates_applied')) {
    return 'The answer would change every side of this conflict, but the changes are still waiting for you to accept them.';
  }

  if (failed.includes('semantic_agreement')) {
    return 'The answer changed these requirements without settling what they disagree about.';
  }

  if (failed.includes('authoritative_not_assumption')) {
    return 'This answer was recorded as an assumption, and an assumption does not settle a contradiction between two things the client said.';
  }

  if (failed.includes('confirmed_answer')) {
    return 'The answer has not been confirmed as the client’s.';
  }

  return `Not settled: ${failed.map((condition) => RESOLUTION_CONDITION_LABELS[condition].toLowerCase()).join('; ')}.`;
}
