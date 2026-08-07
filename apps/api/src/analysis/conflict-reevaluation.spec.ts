import {
  evaluateConflictAgainstClarification,
  isBlockingConflict,
  type ConflictStatus,
  type ReevaluationFacts,
} from '@wdrg/contracts';

/**
 * The rule that decides whether a confirmed answer settles a contradiction.
 *
 * The most consequential automatic decision in this phase: a conflict is two
 * client statements that cannot both be true, and marking one settled without
 * cause hides a contradiction inside a document somebody will sign. So the
 * decision is deterministic, and every one of its conditions is tested here.
 *
 * The model's role is a **veto**. It appears as one boolean among six, it can
 * only withhold, and there is no confidence anywhere in the input — a fact
 * asserted below, because a confidence field would eventually be thresholded.
 */

function facts(overrides: Partial<ReevaluationFacts> = {}): ReevaluationFacts {
  return {
    answerConfirmed: true,
    isAssumption: false,
    linkedItemIds: ['req_1'],
    positionItemIds: ['req_1', 'req_2'],
    appliedItemIds: ['req_1', 'req_2'],
    proposedItemIds: [],
    semanticAgreement: true,
    ...overrides,
  };
}

describe('conflict re-evaluation', () => {
  it('resolves only when every condition holds', () => {
    const outcome = evaluateConflictAgainstClarification(facts());

    expect(outcome.status).toBe('resolved_by_clarification');
    expect(outcome.conditionsFailed).toEqual([]);
    expect(outcome.conditionsMet).toHaveLength(6);
  });

  it.each<[string, Partial<ReevaluationFacts>]>([
    ['the answer was never confirmed', { answerConfirmed: false }],
    ['it was recorded as an assumption', { isAssumption: true }],
    ['only one side was updated', { appliedItemIds: ['req_1'] }],
    [
      'the update is waiting for a person',
      { appliedItemIds: [], proposedItemIds: ['req_1', 'req_2'] },
    ],
    ['the model did not agree', { semanticAgreement: false }],
  ])('refuses to resolve when %s', (_label, override) => {
    const outcome = evaluateConflictAgainstClarification(facts(override));

    expect(outcome.status).not.toBe('resolved_by_clarification');
    expect(outcome.conditionsFailed.length).toBeGreaterThan(0);
    // Whatever it becomes, it still stops approval.
    expect(isBlockingConflict({ severity: 'blocking', status: outcome.status })).toBe(true);
  });

  it('leaves an unrelated conflict alone rather than calling it re-checked', () => {
    /*
     * "Still conflicting" implies somebody looked at the substance. Nobody did:
     * the clarification does not touch either side.
     */
    const outcome = evaluateConflictAgainstClarification(
      facts({ linkedItemIds: [], appliedItemIds: [], proposedItemIds: [] }),
    );

    expect(outcome.status).toBe('open');
    expect(outcome.rationale).toMatch(/does not touch/i);
  });

  it('asks for a person when the answer reached every side but did not settle it', () => {
    const outcome = evaluateConflictAgainstClarification(facts({ semanticAgreement: false }));

    expect(outcome.status).toBe('needs_review');
    expect(outcome.rationale).toMatch(/without settling/i);
  });

  it('stays a contradiction when one side is untouched', () => {
    const outcome = evaluateConflictAgainstClarification(facts({ appliedItemIds: ['req_1'] }));

    expect(outcome.status).toBe('still_conflicting');
    expect(outcome.rationale).toMatch(/left 1 contradicting requirement untouched/i);
  });

  it('the model cannot supply a condition, only withhold one', () => {
    /*
     * Agreement with everything else failing changes nothing — which is what
     * makes it a veto rather than a vote.
     */
    const withAgreement = evaluateConflictAgainstClarification(
      facts({ answerConfirmed: false, semanticAgreement: true }),
    );
    const without = evaluateConflictAgainstClarification(
      facts({ answerConfirmed: false, semanticAgreement: false }),
    );

    expect(withAgreement.status).not.toBe('resolved_by_clarification');
    expect(without.status).not.toBe('resolved_by_clarification');
  });

  it('has nowhere to put a model confidence', () => {
    // A confidence field would eventually be thresholded, and a threshold is a
    // way for a number the model produced to clear a blocker.
    const keys = Object.keys(facts());

    expect(keys.some((key) => key.toLowerCase().includes('confidence'))).toBe(false);
    expect(keys.some((key) => key.toLowerCase().includes('score'))).toBe(false);
  });

  it('explains itself in words a reviewer can act on', () => {
    for (const override of [
      { appliedItemIds: ['req_1'] },
      { appliedItemIds: [], proposedItemIds: ['req_1', 'req_2'] },
      { semanticAgreement: false },
      { isAssumption: true },
      { answerConfirmed: false },
    ]) {
      const outcome = evaluateConflictAgainstClarification(facts(override));

      expect(outcome.rationale.length).toBeGreaterThan(20);
      expect(outcome.rationale).not.toMatch(/undefined|null|\{/);
    }
  });

  it.each<[ConflictStatus, boolean]>([
    ['open', true],
    ['still_conflicting', true],
    ['needs_review', true],
    ['resolved_by_clarification', false],
    ['resolved', false],
    ['dismissed', false],
    ['accepted_risk', false],
    ['superseded', false],
  ])('a blocking conflict in %s blocks approval: %s', (status, blocks) => {
    expect(isBlockingConflict({ severity: 'blocking', status })).toBe(blocks);
  });

  it('a non-blocking conflict never blocks, whatever its status', () => {
    for (const severity of ['major', 'minor'] as const) {
      expect(isBlockingConflict({ severity, status: 'still_conflicting' })).toBe(false);
    }
  });
});
