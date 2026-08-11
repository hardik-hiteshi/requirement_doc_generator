import type { DocumentBlocker } from './document-snapshot.contract';
import type { DocumentValidation } from './document-validation.contract';
import type { DocumentSection } from './document-section.contract';
import type { DocumentOutdatedReason } from './document-dependency';
import type { FeatureCoverage, EffortReconciliation } from './feature-listing.contract';
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
  const pendingRows = input.pendingFeatureIds ?? [];
  const pending = pendingSections.length + pendingRows.length;

  if (pending > 0) {
    const noun = pendingSections.length > 0 ? 'section' : 'feature';

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
