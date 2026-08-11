import { Injectable } from '@nestjs/common';
import {
  contradictoryAssumptions,
  entersApprovedDocument,
  isAuthoritativeProvenance,
  summariseAssumptions,
  type Assumption,
  type AssumptionCategory,
  type ValidationFinding,
} from '@wdrg/contracts';

import {
  type ComposedContent,
  type ComposedRow,
  type DocumentComposer,
  type UpstreamContext,
  type ValidationInput,
} from './composer.types';

/**
 * Assumptions — Document 4.
 *
 * ## What deterministic composition produces, and why it is usually short
 *
 * Only what somebody has already stood behind. There is exactly one such source in
 * the upstream chain: a clarification whose answer the user marked as an assumption
 * rather than a client fact. Phase 4 made them choose at the time, so that mark is a
 * recorded decision, and turning it into a row here adds nothing.
 *
 * That means a project where nobody flagged an assumption gets an **empty**
 * Assumptions document, and the right response to that is not to fill it. A generator
 * that produced eight plausible assumptions from a thin brief would be doing the one
 * thing this document exists to prevent: converting things nobody asked about into
 * things that read as agreed.
 *
 * So the empty document is a legitimate outcome, and the screen says so.
 *
 * ## Where candidates come from instead
 *
 * A model reading the requirements genuinely does notice what a plan is resting on,
 * and that is useful. Those arrive through `assumptionCandidates` as `DRAFT` rows
 * with provenance `MODEL_SUGGESTED`, they are visibly candidates, and
 * `entersApprovedDocument` keeps every one of them out of an approved document until
 * a person confirms it. Approval is blocked while any candidate is undecided — not
 * because candidates are bad, but because leaving one unread is how a suggestion
 * becomes a commitment by default.
 *
 * ## Missing information is not an assumption
 *
 * An unanswered clarification stays an unanswered clarification. Phase 4 owns it,
 * a blocking one stays blocking, and nothing in this document clears it —
 * `openQuestionsTreatedAsAssumptions` checks for exactly that and blocks approval if
 * it finds it.
 */
@Injectable()
export class AssumptionsComposer implements DocumentComposer {
  readonly type = 'ASSUMPTIONS' as const;
  readonly shape = 'ROWS' as const;
  readonly requiredSectionKeys = [];
  readonly rowKind = 'ASSUMPTION' as const;
  /* An empty Assumptions document is the correct answer, not a failed one. */
  readonly mayBeEmpty = true;

  compose(context: UpstreamContext): ComposedContent {
    const rows: ComposedRow[] = [];

    /*
     * One row per clarification the user marked as an assumption. Confirmed only:
     * an answer nobody confirmed is still being settled, and recording it here
     * would be this document deciding that the conversation is over.
     */
    const flagged = context.clarifications.filter(
      (clarification) => clarification.isAssumption && clarification.confirmed,
    );

    for (const [index, clarification] of flagged.entries()) {
      const assumption: Assumption = {
        assumptionKey: `AS-${String(index + 1).padStart(3, '0')}`,
        category: this.categoryFor(clarification.question, clarification.answer),
        statement: clarification.answer.trim(),
        /* A person chose this label in Phase 4. That is the provenance. */
        provenance: 'CONFIRMED_CLARIFICATION',
        basis: `Recorded when answering "${clarification.question.trim()}" (${clarification.label}).`,
        status: 'CONFIRMED',
        requirementIds: [],
        featureIds: [],
        technologyIds: [],
        estimateUnitIds: [],
        owner: '',
        /*
         * Impact is not guessed. An assumption arriving from a settled
         * clarification has no measured consequence attached to it, so it is
         * recorded as MEDIUM and the fields that would state a consequence are left
         * for a person to fill in. Inventing "HIGH — the timeline would slip by
         * three weeks" would be a fabricated quantity in a risk column.
         */
        impact: 'MEDIUM',
        impactAreas: [],
        impactIfFalse: '',
        validationNeeded: '',
        validateBy: '',
        confirmedBy: 'USER',
        notes: '',
      };

      rows.push({
        order: index,
        references: [{ kind: 'CLARIFICATION', id: clarification.id, label: clarification.label }],
        payload: { ...assumption },
      });
    }

    return { sections: [], features: [], rows };
  }

  /**
   * Which category this assumption belongs to, from its own words.
   *
   * A guess at a filing label is harmless — it changes nothing about whether the
   * assumption is authoritative, and a person can change it. `OTHER` is the honest
   * default rather than a forced choice.
   */
  private categoryFor(question: string, answer: string): AssumptionCategory {
    const text = `${question} ${answer}`.toLowerCase();

    const rules: readonly [RegExp, AssumptionCategory][] = [
      [/\b(client|customer|they will provide|supplied by)\b/, 'CLIENT'],
      [/\b(integrat|api|third[- ]party|webhook|endpoint)\b/, 'INTEGRATION'],
      [/\b(data|migrat|record|import|export|format)\b/, 'DATA'],
      [/\b(environment|server|host|infrastructure|network)\b/, 'ENVIRONMENT'],
      [/\b(deploy|release|rollout|go[- ]live)\b/, 'DEPLOYMENT'],
      [/\b(estimate|effort|hours|capacity)\b/, 'ESTIMATION'],
      [/\b(timeline|deadline|schedule|delivery)\b/, 'DELIVERY'],
      [/\b(complian|gdpr|regulat|audit|legal)\b/, 'COMPLIANCE'],
      [/\b(technolog|stack|framework|library|version)\b/, 'TECHNICAL'],
      [/\b(process|approval|workflow|business)\b/, 'BUSINESS'],
      [/\b(feature|screen|function)\b/, 'FUNCTIONAL'],
    ];

    for (const [pattern, category] of rules) {
      if (pattern.test(text)) {
        return category;
      }
    }

    return 'OTHER';
  }

  /* --------------------------------------------------------- validation */

  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const assumptions = input.rows.map((row) => row.payload as Assumption);

    /* 1. Provenance. The question this document exists to make answerable. */
    const unprovenanced = assumptions.filter(
      (assumption) =>
        assumption.status === 'CONFIRMED' && !isAuthoritativeProvenance(assumption.provenance),
    );

    if (unprovenanced.length > 0) {
      findings.push({
        kind: 'assumption_unprovenanced',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unprovenanced.length} assumption is marked confirmed without anybody standing behind it.`,
        action:
          'Say what each one rests on — the client stated it, you are stating it, or a clarification settled it.',
        subjectIds: unprovenanced.map((assumption) => assumption.assumptionKey),
      });
    }

    /* 2. Candidates nobody has decided about. */
    const candidates = assumptions.filter((assumption) => assumption.status === 'DRAFT');

    if (candidates.length > 0) {
      findings.push({
        kind: 'assumption_unconfirmed',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${candidates.length} suggested assumption is still waiting for a decision.`,
        action:
          'Confirm the ones you stand behind and reject the rest. A suggestion never becomes an assumption on its own.',
        subjectIds: candidates.map((assumption) => assumption.assumptionKey),
      });
    }

    /* 3. Two confirmed assumptions that cannot both be true. */
    const contradictions = contradictoryAssumptions(assumptions);

    if (contradictions.length > 0) {
      findings.push({
        kind: 'assumption_contradiction',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${contradictions.length} pair of confirmed assumptions contradict each other.`,
        action: 'Reject or replace one of each pair — both cannot be true.',
        subjectIds: contradictions.flatMap((pair) => [...pair]),
      });
    }

    /*
     * 4. An unanswered question turned into an assumption.
     *
     * The specific failure this document is built against. An assumption whose
     * words are the words of a clarification nobody answered means somebody closed
     * a real question by writing a sentence about it.
     */
    const laundered = this.openQuestionsTreatedAsAssumptions(input.context, assumptions);

    if (laundered.length > 0) {
      findings.push({
        kind: 'open_question_as_assumption',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${laundered.length} assumption restates a question that is still open.`,
        action:
          'A missing answer is not an assumption. Answer the clarification, or say who is standing behind this as an assumption and why.',
        subjectIds: [...laundered],
      });
    }

    /* 5. A confirmed assumption whose failure would stop the plan. */
    const summary = summariseAssumptions(assumptions);

    if (summary.blockingUnresolved.length > 0) {
      findings.push({
        kind: 'assumption_blocking_unresolved',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${summary.blockingUnresolved.length} unresolved assumption would stop the plan if it were wrong.`,
        action: 'Settle each one, or accept it explicitly, before this document is approved.',
        subjectIds: [...summary.blockingUnresolved],
      });
    }

    /* 6. Citations that name something real. */
    const approved = new Set(input.context.requirements.map((requirement) => requirement.key));
    const unknown = [
      ...new Set(
        assumptions.flatMap((assumption) =>
          assumption.requirementIds.filter((key) => !approved.has(key)),
        ),
      ),
    ];

    if (unknown.length > 0) {
      findings.push({
        kind: 'unknown_requirement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknown.length} assumption is linked to a requirement that is not in the approved baseline.`,
        action: 'Relink it, or regenerate this document against the current baseline.',
        subjectIds: unknown,
      });
    }

    const rejectedBasis = input.context.allRequirements.filter(
      (requirement) =>
        requirement.status === 'rejected' &&
        assumptions.some(
          (assumption) =>
            entersApprovedDocument(assumption) &&
            assumption.requirementIds.includes(requirement.key),
        ),
    );

    if (rejectedBasis.length > 0) {
      findings.push({
        kind: 'rejected_requirement_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${rejectedBasis.length} confirmed assumption rests on a requirement that was rejected.`,
        action: 'Reject the assumption, or relink it to something that is still in scope.',
        subjectIds: rejectedBasis.map((requirement) => requirement.key),
      });
    }

    /* 7. And the state of the document, recorded as a fact either way. */
    findings.push(
      candidates.length === 0 && unprovenanced.length === 0
        ? {
            kind: 'assumption_unprovenanced',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: `Every assumption here has somebody behind it: ${summary.confirmed} confirmed, ${summary.rejected} rejected.`,
            action: '',
            subjectIds: [],
          }
        : {
            kind: 'assumption_unconfirmed',
            severity: 'WARNING',
            detectedBy: 'DETERMINISTIC',
            summary: `${summary.candidates} of ${summary.total} entries are still suggestions.`,
            action: 'Work through them — each needs a yes or a no.',
            subjectIds: [],
          },
    );

    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'The approved requirements have changed since these assumptions were recorded.',
        action: 'Read what changed — an assumption may no longer be needed, or may now be wrong.',
        subjectIds: [],
      });
    }

    return findings;
  }

  /**
   * Assumptions that are really unanswered questions wearing a different hat.
   *
   * Compared against clarifications that are still open. An assumption whose
   * statement repeats the substance of an unanswered question is the laundering
   * this document must not do — matched on the question's distinctive words rather
   * than on meaning, because a checker that guessed would be dismissed.
   */
  private openQuestionsTreatedAsAssumptions(
    context: UpstreamContext,
    assumptions: readonly Assumption[],
  ): readonly string[] {
    const open = context.clarifications.filter((clarification) => !clarification.confirmed);

    if (open.length === 0) {
      return [];
    }

    const significant = (value: string): Set<string> =>
      new Set(
        value
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length > 4),
      );

    const found: string[] = [];

    for (const assumption of assumptions) {
      if (!entersApprovedDocument(assumption)) {
        continue;
      }

      /* An assumption citing the clarification it came from is legitimate. */
      const cited = new Set(
        assumption.requirementIds.concat(assumption.statement.length > 0 ? [] : []),
      );

      for (const question of open) {
        const questionWords = significant(question.question);
        const statementWords = significant(assumption.statement);
        const shared = [...questionWords].filter((word) => statementWords.has(word));

        /*
         * Three or more distinctive words in common, and at least half the
         * question's own vocabulary. Two words overlap by coincidence; this does
         * not.
         */
        if (
          shared.length >= 3 &&
          shared.length >= questionWords.size / 2 &&
          !cited.has(question.id)
        ) {
          found.push(assumption.assumptionKey);
          break;
        }
      }
    }

    return [...new Set(found)];
  }

  /** The counts a reader needs, and the screen shows. */
  summaryFor(input: ValidationInput) {
    return summariseAssumptions(input.rows.map((row) => row.payload as Assumption));
  }

  /**
   * Requirements this document answers for.
   *
   * None. Assumptions are not a mapping of the requirements — a project can have
   * fifty requirements and no assumptions at all, and reporting that as nought per
   * cent coverage would pressure somebody into inventing some.
   */
  applicableRequirementIds(): readonly string[] {
    return [];
  }
}
