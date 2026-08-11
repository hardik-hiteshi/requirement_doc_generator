import { Injectable } from '@nestjs/common';
import {
  calculateCriteriaCoverage,
  criterionFingerprint,
  criterionText,
  nextCriterionKey,
  unstatedThresholds,
  type AcceptanceCriterion,
  type CriterionAspect,
  type FeatureRow,
  type RequirementItem,
  type ValidationFinding,
} from '@wdrg/contracts';

import {
  requirementReference,
  type ComposedContent,
  type ComposedRow,
  type DocumentComposer,
  type UpstreamContext,
  type ValidationInput,
} from './composer.types';

/**
 * Acceptance Criteria — Document 3.
 *
 * ## One criterion per feature, per aspect the evidence supports
 *
 * The Feature Listing already divided the work into rows a client agreed to, so a
 * feature is the natural unit: for each row, what would have to be true for that
 * row to be accepted?
 *
 * The number of criteria per feature comes from the *requirement*, not from a
 * target. A requirement that says "a manager must approve before export" yields a
 * behaviour criterion and a permission criterion, because it states both. A
 * requirement that says "staff record hours weekly" yields one. Generating a
 * criterion per UI label would bury the conditions that matter, and generating one
 * per module would make each too big to accept or reject.
 *
 * `aspectsFor` is where that judgement lives, and it reads the requirement's own
 * words. It is deliberately conservative: a criterion the evidence does not
 * support is worse than a missing one, because it gets agreed to.
 *
 * ## Deterministic, and readable
 *
 * The composed text is assembled from the requirement's own statement. It reads
 * plainly — "Then the timesheet is recorded and shown as submitted" — because a
 * client has to be able to agree to it. A model may rewrite the wording later; it
 * cannot add a threshold, change a feature, or cite a requirement it was not given.
 */
@Injectable()
export class AcceptanceCriteriaComposer implements DocumentComposer {
  readonly type = 'ACCEPTANCE_CRITERIA' as const;
  readonly shape = 'ROWS' as const;
  readonly requiredSectionKeys = [];
  readonly rowKind = 'ACCEPTANCE_CRITERION' as const;

  compose(context: UpstreamContext): ComposedContent {
    const features = context.documents.featureListing?.features ?? [];
    const byKey = new Map(
      context.requirements.map((requirement) => [requirement.key, requirement]),
    );

    const criteria: AcceptanceCriterion[] = [];

    for (const feature of features) {
      const requirements = feature.requirementIds
        .map((key) => byKey.get(key))
        .filter((requirement): requirement is RequirementItem => requirement !== undefined);

      if (requirements.length === 0) {
        continue;
      }

      for (const aspect of this.aspectsFor(requirements)) {
        criteria.push(
          this.criterionFor(
            nextCriterionKey(criteria.map((existing) => existing.criterionKey)),
            feature,
            requirements,
            aspect,
            context,
          ),
        );
      }
    }

    /*
     * Two criteria that say the same thing about the same feature are one
     * criterion. This happens legitimately — two requirements can state the same
     * permission rule — and the sheet should say it once.
     */
    const seen = new Set<string>();
    const rows: ComposedRow[] = [];

    for (const criterion of criteria) {
      const fingerprint = criterionFingerprint(criterion);

      if (seen.has(fingerprint)) {
        continue;
      }

      seen.add(fingerprint);

      rows.push({
        order: rows.length,
        references: [
          ...criterion.requirementIds
            .map((key) => byKey.get(key))
            .filter((requirement): requirement is RequirementItem => requirement !== undefined)
            .map(requirementReference),
          ...criterion.featureIds.map((id) => ({ kind: 'ESTIMATE_UNIT' as const, id })),
        ],
        payload: { ...criterion },
      });
    }

    /* Keys are assigned after deduplication so the sheet reads AC-001 upwards. */
    return {
      sections: [],
      features: [],
      rows: rows.map((row, index) => ({
        ...row,
        order: index,
        payload: {
          ...row.payload,
          criterionKey: `AC-${String(index + 1).padStart(3, '0')}`,
        },
      })),
    };
  }

  /**
   * Which kinds of condition this requirement actually states.
   *
   * Read from its own words. `BEHAVIOUR` is always present — every requirement
   * describes something that should happen — and the rest are added only on
   * evidence, because a permission criterion for a requirement that says nothing
   * about permissions is a condition somebody would have to agree to on trust.
   */
  private aspectsFor(requirements: readonly RequirementItem[]): readonly CriterionAspect[] {
    const text = requirements
      .map((requirement) => `${requirement.title} ${requirement.statement}`)
      .join(' ')
      .toLowerCase();

    const aspects: CriterionAspect[] = ['BEHAVIOUR'];

    if (/\b(approv|permission|role|only|authoris|authoriz|restrict|admin|manager)\b/.test(text)) {
      aspects.push('PERMISSION');
    }

    if (
      /\b(valid|require[ds]?|mandatory|must (not )?(be|contain|exceed)|reject|duplicate)\b/.test(
        text,
      )
    ) {
      aspects.push('VALIDATION');
    }

    if (/\b(export|import|integrat|api|webhook|sync|third[- ]party|payroll)\b/.test(text)) {
      aspects.push('INTEGRATION');
    }

    if (/\b(histor|audit|retain|store[ds]?|record[ds]?|log)\b/.test(text)) {
      aspects.push('DATA');
    }

    /*
     * A non-functional criterion only where the requirement was classified as one
     * *and* states something measurable. Phase 4's category is the authority; the
     * words are the check that there is something to state.
     */
    if (
      requirements.some((requirement) => requirement.category === 'non_functional') &&
      /\d/.test(text)
    ) {
      aspects.push('NON_FUNCTIONAL');
    }

    return aspects;
  }

  private criterionFor(
    criterionKey: string,
    feature: FeatureRow,
    requirements: readonly RequirementItem[],
    aspect: CriterionAspect,
    context: UpstreamContext,
  ): AcceptanceCriterion {
    const primary = requirements[0]!;
    const actor = this.actorFor(requirements, context);
    const statement = primary.statement.trim().replace(/\.$/, '');

    /*
     * The observable outcome, phrased for the aspect. Each of these is a
     * restatement of the requirement rather than an addition to it — nothing here
     * introduces a fact the requirement did not contain.
     */
    const then: Record<CriterionAspect, string> = {
      BEHAVIOUR: `${statement}, and the result is visible to the person who did it`,
      PERMISSION: `only ${actor || 'an authorised user'} can carry this out, and anyone else is refused`,
      VALIDATION: `input that does not satisfy the rule is refused, with a message saying why`,
      INTEGRATION: `the exchange with the other system completes, and a failure is reported rather than silent`,
      DATA: `the record is stored and can be retrieved afterwards`,
      NON_FUNCTIONAL: statement,
    };

    const when: Record<CriterionAspect, string> = {
      BEHAVIOUR: feature.screen ? `${actor || 'a user'} uses ${feature.screen}` : '',
      PERMISSION: `the action is attempted`,
      VALIDATION: `the input is submitted`,
      INTEGRATION: `the exchange runs`,
      DATA: '',
      NON_FUNCTIONAL: '',
    };

    return {
      criterionKey,
      requirementIds: requirements.map((requirement) => requirement.key),
      featureIds: [feature.featureId],
      module: feature.module,
      submodule: feature.submodule,
      screen: feature.screen,
      actor,
      aspect,
      given: actor && aspect === 'BEHAVIOUR' ? `${actor} is signed in` : '',
      when: when[aspect],
      then: then[aspect],
      rule: primary.statement,
      /* Only the requirement itself may ask for a procedure. */
      requiresProcedure: /\b(step[- ]by[- ]step|procedure|test script|test case)\b/i.test(
        `${primary.title} ${primary.statement}`,
      ),
      status: 'DRAFT',
      notes: '',
    };
  }

  /**
   * The role the requirement names, if it names one.
   *
   * Read out of the requirement's own words, and empty when it names nobody. There
   * is no roles field on a requirement to consult, and inventing "the user" would
   * put an actor into an acceptance condition that the requirement never had —
   * which is exactly the kind of small fabrication that gets agreed to.
   *
   * The words come from the project's own user-role requirements, so a project that
   * calls them "approvers" gets "approver" rather than a generic guess.
   */
  private actorFor(requirements: readonly RequirementItem[], context: UpstreamContext): string {
    const roleWords = new Set(
      context.requirements
        .filter((requirement) => requirement.category === 'user_role')
        .flatMap((requirement) =>
          `${requirement.title} ${requirement.statement}`
            .toLowerCase()
            .split(/[^a-z]+/)
            .filter((word) => word.length > 3),
        ),
    );

    const common = ['staff', 'manager', 'admin', 'administrator', 'approver', 'employee', 'client'];

    for (const requirement of requirements) {
      const words = requirement.statement.toLowerCase().split(/[^a-z]+/);

      for (const word of words) {
        if (roleWords.has(word) || common.includes(word)) {
          return word;
        }
      }
    }

    return '';
  }

  /* --------------------------------------------------------- validation */

  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const criteria = input.rows
      .filter((row) => row.excludedReason === undefined)
      .map((row) => row.payload as AcceptanceCriterion);

    const approved = new Set(input.context.requirements.map((requirement) => requirement.key));
    const features = input.context.documents.featureListing?.features ?? [];
    const featureIds = new Set(features.map((feature) => feature.featureId));

    /* 1. Every citation names something that exists and is still approved. */
    const unknownRequirements = [
      ...new Set(
        criteria.flatMap((criterion) =>
          criterion.requirementIds.filter((key) => !approved.has(key)),
        ),
      ),
    ];

    if (unknownRequirements.length > 0) {
      findings.push({
        kind: 'unknown_requirement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknownRequirements.length} criterion cites a requirement that is not in the approved baseline.`,
        action: unknownRequirements.join(', '),
        subjectIds: unknownRequirements,
      });
    }

    const rejected = input.context.allRequirements.filter(
      (requirement) =>
        requirement.status === 'rejected' &&
        criteria.some((criterion) => criterion.requirementIds.includes(requirement.key)),
    );

    if (rejected.length > 0) {
      findings.push({
        kind: 'rejected_requirement_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${rejected.length} criterion is about a requirement that was rejected.`,
        action: rejected.map((requirement) => requirement.key).join(', '),
        subjectIds: rejected.map((requirement) => requirement.key),
      });
    }

    const unknownFeatures = [
      ...new Set(
        criteria.flatMap((criterion) => criterion.featureIds.filter((id) => !featureIds.has(id))),
      ),
    ];

    if (unknownFeatures.length > 0) {
      findings.push({
        kind: 'unknown_feature_reference',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknownFeatures.length} criterion is about a feature that is not in the current Feature Listing.`,
        action:
          'A criterion can only be about scope somebody agreed to. Regenerate this document against the current listing.',
        subjectIds: unknownFeatures,
      });
    }

    /*
     * 2. Thresholds. The most expensive thing this document can get wrong, so it
     * blocks: a warning would be acknowledged and the commitment would ship.
     */
    const evidence = input.context.requirements
      .map((requirement) => `${requirement.title} ${requirement.statement}`)
      .join('\n');

    const invented = criteria.flatMap((criterion) =>
      unstatedThresholds(criterionText(criterion), evidence).map((threshold) => ({
        criterion,
        threshold,
      })),
    );

    if (invented.length > 0) {
      findings.push({
        kind: 'unstated_threshold',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${invented.length} criterion states a figure or standard the approved requirements do not.`,
        action: invented
          .map(
            ({ criterion, threshold }) =>
              `${criterion.criterionKey} states ${threshold.kind} ("${threshold.quote}") that nothing approved contains.`,
          )
          .join(' '),
        subjectIds: invented.map(({ criterion }) => criterion.criterionKey),
      });
    }

    /* 3. Scope somebody deliberately excluded has no criteria. */
    const excluded = new Set(input.excludedRequirementIds);
    const forExcluded = criteria.filter((criterion) =>
      criterion.requirementIds.some((key) => excluded.has(key)),
    );

    if (forExcluded.length > 0) {
      findings.push({
        kind: 'criterion_for_excluded_scope',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${forExcluded.length} criterion is about scope that was deliberately left out.`,
        action:
          'Either the exclusion is wrong or the criterion is. Both cannot be in an approved document.',
        subjectIds: forExcluded.map((criterion) => criterion.criterionKey),
      });
    }

    /* 4. Two criteria saying the same thing about the same feature. */
    const byFingerprint = new Map<string, string[]>();

    for (const criterion of criteria) {
      const fingerprint = criterionFingerprint(criterion);
      byFingerprint.set(fingerprint, [
        ...(byFingerprint.get(fingerprint) ?? []),
        criterion.criterionKey,
      ]);
    }

    const duplicates = [...byFingerprint.values()].filter((keys) => keys.length > 1);

    if (duplicates.length > 0) {
      findings.push({
        kind: 'duplicate_content',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${duplicates.length} acceptance condition appears more than once.`,
        action: duplicates.map((keys) => keys.join(' and ')).join('; '),
        subjectIds: duplicates.flat(),
      });
    }

    /* 5. Coverage, and 6. criteria that support nothing. */
    const coverage = this.coverageFor(input);

    if (coverage.unsupportedCriterionKeys.length > 0) {
      findings.push({
        kind: 'criterion_unsupported',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${coverage.unsupportedCriterionKeys.length} criterion cites neither a requirement nor a feature.`,
        action: 'Link each one to what it is about, or remove it.',
        subjectIds: [...coverage.unsupportedCriterionKeys],
      });
    }

    const uncovered = [...coverage.uncoveredRequirementIds, ...coverage.uncoveredFeatureIds];

    findings.push(
      uncovered.length === 0
        ? {
            kind: 'requirement_uncovered',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: `Every approved requirement and feature has an acceptance criterion, or a recorded decision not to have one.`,
            action: `${coverage.coveredRequirements} of ${coverage.applicableRequirements} requirements and ${coverage.coveredFeatures} of ${coverage.applicableFeatures} features.`,
            subjectIds: [],
          }
        : {
            kind: 'feature_uncovered',
            severity: 'BLOCKING',
            detectedBy: 'DETERMINISTIC',
            summary: `${uncovered.length} approved item has no acceptance criterion and no decision to leave one out.`,
            action:
              'Write a criterion for each, or record that it is deliberately not covered and why.',
            subjectIds: uncovered,
          },
    );

    /* 7. Rows a person added with nothing saying where they came from. */
    const unattributed = input.rows
      .filter(
        (row) =>
          row.origin === 'USER_DEFINED' &&
          row.references.length === 0 &&
          (row.attribution ?? '').trim().length === 0,
      )
      .map((row) => (row.payload as AcceptanceCriterion).criterionKey);

    if (unattributed.length > 0) {
      findings.push({
        kind: 'attribution_missing',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unattributed.length} criterion was added by hand with nothing recorded about where it came from.`,
        action: 'Say what each one rests on — a criterion nobody can trace cannot be agreed.',
        subjectIds: unattributed,
      });
    }

    /* 8. The upstream authority this document quotes. */
    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'The approved requirements have changed since these criteria were written.',
        action: 'Regenerate against the current baseline.',
        subjectIds: [],
      });
    }

    return findings;
  }

  /** Coverage over the approved requirements and the approved features. */
  coverageFor(input: ValidationInput) {
    const criteria = input.rows
      .filter((row) => row.excludedReason === undefined)
      .map((row) => row.payload as AcceptanceCriterion);

    const features = input.context.documents.featureListing?.features ?? [];

    return calculateCriteriaCoverage({
      applicableRequirementIds: this.applicableRequirementIds(input.context),
      applicableFeatureIds: features.map((feature) => feature.featureId),
      criteria: criteria.map((criterion) => ({
        criterionKey: criterion.criterionKey,
        requirementIds: criterion.requirementIds,
        featureIds: criterion.featureIds,
        status: criterion.status,
      })),
      excludedRequirementIds: input.excludedRequirementIds,
      excludedFeatureIds: input.rows
        .filter((row) => row.excludedReason !== undefined)
        .flatMap((row) => (row.payload as AcceptanceCriterion).featureIds),
    });
  }

  /**
   * Requirements this document answers for.
   *
   * Everything approved and functional, plus any non-functional requirement that
   * states something checkable. A non-functional requirement with no figure and no
   * observable condition — "the system should be pleasant to use" — is excluded,
   * because inventing a criterion for it would mean inventing the standard.
   */
  applicableRequirementIds(context: UpstreamContext): readonly string[] {
    return context.requirements
      .filter(
        (requirement) =>
          requirement.category !== 'non_functional' ||
          /\d/.test(`${requirement.title} ${requirement.statement}`),
      )
      .map((requirement) => requirement.key);
  }
}
