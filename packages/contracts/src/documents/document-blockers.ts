import type { DocumentBlocker } from './document-snapshot.contract';
import type { DocumentValidation } from './document-validation.contract';
import type { DocumentSection } from './document-section.contract';
import type { DocumentOutdatedReason } from './document-dependency';
import type { FeatureCoverage, EffortReconciliation } from './feature-listing.contract';
import type { CriteriaCoverage } from './acceptance-criteria.contract';
import type { AssumptionSummary } from './assumptions.contract';
import type { SowScopeReconciliation } from './statement-of-work.contract';
import type { WbsCoverage, WbsReconciliation } from './work-breakdown.contract';
import { hasProposal } from './document-section.contract';

/**
 * Everything standing between a document and approval.
 *
 * Same discipline as Phases 4, 5 and 6: computed from stored data, each entry
 * naming what to do about it, approval refused while any remain.
 *
 * Two of these deserve their reasoning stated.
 *
 * **`unresolved_proposal`.** A regeneration that produced a replacement for a
 * section a person wrote leaves the decision open. Approving while that sits
 * there would mean approving a document with two versions of a section in it,
 * one of them invisible.
 *
 * **`coverage_incomplete`.** A Feature Listing missing requirements is the
 * failure that costs money — the client signs a scope that quietly omits work
 * somebody will discover in delivery. It blocks, and the way through is a
 * decision per requirement, not a global override.
 */

export interface DocumentBlockerInput {
  readonly generated: boolean;
  readonly sections: readonly DocumentSection[];
  readonly requiredSectionKeys: readonly string[];
  readonly validation: DocumentValidation | null;
  readonly outdatedReasons: readonly DocumentOutdatedReason[];
  readonly coverage: FeatureCoverage | null;
  readonly reconciliation: EffortReconciliation | null;
  /** Prerequisite documents that are not approved. */
  readonly unapprovedPrerequisites: readonly string[];
  /** Feature rows with a suggested rewrite waiting for a decision. */
  readonly pendingFeatureIds?: readonly string[];
  /** Structured rows with a suggested rewrite waiting for a decision. */
  readonly pendingRowIds?: readonly string[];
  /** Rows added by hand with nothing saying where they came from. */
  readonly unattributedRowIds?: readonly string[];
  /** Acceptance Criteria coverage, when this is that document. */
  readonly criteriaCoverage?: CriteriaCoverage | null;
  /** Assumption counts, when this is that document. */
  readonly assumptionSummary?: AssumptionSummary | null;
  /** SOW scope reconciliation, when this is that document. */
  readonly scopeReconciliation?: SowScopeReconciliation | null;
  readonly wbsReconciliation?: WbsReconciliation | null;
  readonly wbsCoverage?: WbsCoverage | null;
}

export function calculateDocumentBlockers(input: DocumentBlockerInput): readonly DocumentBlocker[] {
  /*
   * The gates come first and return early. Nothing below them means anything: a
   * document that has not been generated has no content to validate, and one
   * built on an unapproved prerequisite is built on sand.
   */
  if (!input.generated) {
    return [
      {
        kind: 'not_generated',
        count: 1,
        summary: 'This document has not been written yet.',
        action: 'Generate it, or write the sections yourself.',
        subjectIds: [],
      },
    ];
  }

  if (input.unapprovedPrerequisites.length > 0) {
    return [
      {
        kind: 'prerequisite_not_approved',
        count: input.unapprovedPrerequisites.length,
        summary: `${input.unapprovedPrerequisites.join(' and ')} is no longer approved.`,
        action: 'Approve it again — this document is built on it.',
        subjectIds: [...input.unapprovedPrerequisites],
      },
    ];
  }

  const blockers: DocumentBlocker[] = [];

  if (input.outdatedReasons.length > 0) {
    blockers.push({
      kind: 'outdated_inputs',
      count: input.outdatedReasons.length,
      summary: 'Something this document is built on changed after it was written.',
      action: 'Read what changed, then regenerate or edit. Nothing has been altered for you.',
      subjectIds: input.outdatedReasons.map((reason) => reason.cause),
    });
  }

  const blocking = input.validation?.findings.filter((finding) => finding.severity === 'BLOCKING');

  if (blocking && blocking.length > 0) {
    blockers.push({
      kind: 'blocking_validation',
      count: blocking.length,
      summary: `Validation found ${blocking.length} thing${blocking.length === 1 ? '' : 's'} that must be fixed.`,
      action: 'Read the validation findings below — each one names what to change.',
      subjectIds: blocking.flatMap((finding) => finding.subjectIds).slice(0, 200),
    });
  }

  const pendingSections = input.sections.filter(hasProposal);
  const pendingRows = [...(input.pendingFeatureIds ?? []), ...(input.pendingRowIds ?? [])];
  const pending = pendingSections.length + pendingRows.length;

  if (pending > 0) {
    const noun = pendingSections.length > 0 ? 'section' : 'entry';

    blockers.push({
      kind: 'unresolved_proposal',
      count: pending,
      summary: `${pending} ${noun}${pending === 1 ? ' has' : 's have'} a suggested rewrite waiting for your decision.`,
      action: 'Keep what you wrote, use the new version, or edit it — then approve.',
      subjectIds: [...pendingSections.map((section) => section.sectionId), ...pendingRows],
    });
  }

  const empty = input.requiredSectionKeys.filter((key) => {
    const section = input.sections.find((candidate) => candidate.key === key);

    return !section || section.body.trim().length === 0;
  });

  if (empty.length > 0) {
    blockers.push({
      kind: 'empty_required_section',
      count: empty.length,
      summary: `${empty.length} section${empty.length === 1 ? '' : 's'} the document needs ${empty.length === 1 ? 'is' : 'are'} empty.`,
      action: 'Write them, or regenerate — a document cannot be approved without them.',
      subjectIds: empty,
    });
  }

  if (input.coverage && input.coverage.unresolved > 0) {
    blockers.push({
      kind: 'coverage_incomplete',
      count: input.coverage.unresolved,
      summary: `${input.coverage.unresolved} approved requirement${input.coverage.unresolved === 1 ? ' is' : 's are'} in neither a feature nor the excluded list.`,
      action: 'Add a feature for each, or mark it not applicable with a reason.',
      subjectIds: [...input.coverage.unresolvedRequirementIds],
    });
  }

  /*
   * Phase 8. Each of these is the same discipline as coverage above: a fact about
   * stored data, with a way through that is a decision per item rather than an
   * override.
   */
  const unattributed = input.unattributedRowIds ?? [];

  if (unattributed.length > 0) {
    blockers.push({
      kind: 'attribution_missing',
      count: unattributed.length,
      summary: `${unattributed.length} entr${unattributed.length === 1 ? 'y was' : 'ies were'} added by hand with nothing recorded about where ${unattributed.length === 1 ? 'it' : 'they'} came from.`,
      action:
        'Say what each one rests on, or remove it — an entry nobody can trace cannot be approved.',
      subjectIds: [...unattributed],
    });
  }

  if (input.criteriaCoverage && !input.criteriaCoverage.complete) {
    const uncovered = [
      ...input.criteriaCoverage.uncoveredRequirementIds,
      ...input.criteriaCoverage.uncoveredFeatureIds,
    ];

    if (uncovered.length > 0) {
      blockers.push({
        kind: 'coverage_incomplete',
        count: uncovered.length,
        summary: `${uncovered.length} approved ${uncovered.length === 1 ? 'item has' : 'items have'} no acceptance criterion and no decision to leave one out.`,
        action: 'Write a criterion for each, or mark it not applicable with a reason.',
        subjectIds: uncovered.slice(0, 200),
      });
    }

    if (input.criteriaCoverage.unsupportedCriterionKeys.length > 0) {
      blockers.push({
        kind: 'blocking_validation',
        count: input.criteriaCoverage.unsupportedCriterionKeys.length,
        summary: `${input.criteriaCoverage.unsupportedCriterionKeys.length} criterion cites nothing, so nothing supports it.`,
        action: 'Link each one to the requirement or feature it is about, or remove it.',
        subjectIds: [...input.criteriaCoverage.unsupportedCriterionKeys],
      });
    }
  }

  if (input.assumptionSummary) {
    if (input.assumptionSummary.candidates > 0) {
      blockers.push({
        kind: 'unconfirmed_assumptions',
        count: input.assumptionSummary.candidates,
        summary: `${input.assumptionSummary.candidates} suggested assumption${input.assumptionSummary.candidates === 1 ? ' is' : 's are'} waiting for you to accept or turn ${input.assumptionSummary.candidates === 1 ? 'it' : 'them'} down.`,
        action:
          'Confirm the ones you stand behind and reject the rest. A suggestion never becomes an assumption on its own.',
        subjectIds: [],
      });
    }

    if (input.assumptionSummary.blockingUnresolved.length > 0) {
      blockers.push({
        kind: 'blocking_assumption',
        count: input.assumptionSummary.blockingUnresolved.length,
        summary: `${input.assumptionSummary.blockingUnresolved.length} unresolved assumption${input.assumptionSummary.blockingUnresolved.length === 1 ? '' : 's'} would stop the plan if ${input.assumptionSummary.blockingUnresolved.length === 1 ? 'it were' : 'they were'} wrong.`,
        action: 'Settle each one, or accept it explicitly, before this document is approved.',
        subjectIds: [...input.assumptionSummary.blockingUnresolved],
      });
    }
  }

  if (input.scopeReconciliation && !input.scopeReconciliation.reconciled) {
    const subjects = [
      ...input.scopeReconciliation.missingFeatureIds,
      ...input.scopeReconciliation.unknownFeatureIds,
    ];

    blockers.push({
      kind: 'scope_not_reconciled',
      count: Math.max(subjects.length, input.scopeReconciliation.contradictedExclusions.length),
      summary:
        input.scopeReconciliation.contradictedExclusions.length > 0
          ? 'This document describes something as in scope that the approved scope excludes.'
          : `The scope stated here does not match the approved Feature Listing.`,
      action:
        'Regenerate the scope sections — what a commercial document promises has to be what was agreed and estimated.',
      subjectIds: subjects.slice(0, 200),
    });
  }

  /*
   * The work breakdown against its own estimate. Blocking rather than advisory: this
   * document exists to be planned against, and one whose hours differ from the
   * approved plan will be planned against and then found wrong.
   */
  if (input.wbsReconciliation && !input.wbsReconciliation.reconciles) {
    const roles = input.wbsReconciliation.mismatchedRoles;

    blockers.push({
      kind: 'wbs_not_reconciled',
      count: Math.max(
        roles.length,
        input.wbsReconciliation.unmappedEstimateUnitIds.length,
        input.wbsReconciliation.unknownEstimateUnitIds.length,
        1,
      ),
      summary:
        roles.length > 0
          ? `The hours here do not match the approved estimate for ${roles.length === 1 ? roles[0]!.role : `${roles.length} roles`}.`
          : `${input.wbsReconciliation.unmappedEstimateUnitIds.length} priced item has no work against it.`,
      action:
        'A breakdown has to total exactly what was approved. Regenerate it, or change the estimate and approve that instead.',
      subjectIds: [
        ...roles.map((entry) => entry.role),
        ...input.wbsReconciliation.unmappedEstimateUnitIds,
        ...input.wbsReconciliation.unknownEstimateUnitIds,
      ].slice(0, 200),
    });
  }

  if (input.wbsCoverage && !input.wbsCoverage.complete) {
    blockers.push({
      kind: 'coverage_incomplete',
      count:
        input.wbsCoverage.unmappedRequirementIds.length +
        input.wbsCoverage.unsupportedWbsIds.length,
      summary: `${input.wbsCoverage.unmappedRequirementIds.length} priced requirement has no work package.`,
      action: 'Every requirement the estimate priced has to appear as work somebody will do.',
      subjectIds: [
        ...input.wbsCoverage.unmappedRequirementIds,
        ...input.wbsCoverage.unsupportedWbsIds,
      ].slice(0, 200),
    });
  }

  /*
   * Outstanding client dependencies are deliberately *not* a blocker.
   *
   * A blocker prevents approval, and a dependency sheet that could not be approved
   * until the client had sent everything would be useless — sending it is how you ask
   * for the things on it. What is outstanding, and what of it is holding work up, is
   * reported through `dependencySummary` and as a validation finding, where a reader
   * sees it without being stopped by it.
   */

  if (input.reconciliation && !input.reconciliation.reconciles) {
    blockers.push({
      kind: 'effort_mismatch',
      count: 1,
      summary: `The hours here differ from the approved estimate by ${input.reconciliation.differenceHours}.`,
      action:
        'Regenerate this document — the hours come from the estimate, and this one is quoting an older set.',
      subjectIds: [
        ...input.reconciliation.unknownUnitIds,
        ...input.reconciliation.uncitedUnitIds,
      ].slice(0, 200),
    });
  }

  return blockers;
}
