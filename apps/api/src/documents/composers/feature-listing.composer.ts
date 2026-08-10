import { Injectable } from '@nestjs/common';
import {
  aggregateFeatureEffort,
  calculateFeatureCoverage,
  featureTotalHours,
  findDuplicateFeatures,
  inconsistentHierarchy,
  joinDetailPoints,
  reconcileFeatureEffort,
  type EstimateUnit,
  type FeatureRow,
  type RequirementItem,
  type ValidationFinding,
} from '@wdrg/contracts';

import {
  requirementReference,
  unitsForRequirements,
  type ComposedContent,
  type DocumentComposer,
  type UpstreamContext,
  type ValidationInput,
} from './composer.types';

/**
 * Feature Listing, composed from the approved baseline and the approved estimate.
 *
 * ## Where a row comes from
 *
 * The estimate already answers the hard question. Phase 6 produced one estimate
 * unit per requirement, each classified by task category and priced by role — so
 * the natural unit of a feature row is an estimate unit, and the mapping from
 * requirements to features is a mapping the application already holds rather than
 * one a model has to guess.
 *
 * So a row is: one estimate unit, its requirements, its hours. Overhead
 * activities are excluded — "code review" is not a feature a client is buying,
 * and putting it in a feature sheet is how a listing stops being reviewable.
 *
 * The model's contribution is the *names*: which module and submodule a feature
 * belongs to, which screen it appears on, and a description someone can read.
 * That is genuinely useful and genuinely hard to do deterministically, and it
 * touches no number.
 *
 * ## Hours are quoted, never computed here
 *
 * Every figure is copied from the approved estimate and aggregated additively.
 * There is no second effort model in this file, no adjustment, no rounding of a
 * figure somebody signed off. `reconcileFeatureEffort` then proves the document's
 * total equals the estimate's, and a mismatch blocks approval — which makes
 * "the sheet and the estimate agree" a checked property rather than a hope.
 */
@Injectable()
export class FeatureListingComposer implements DocumentComposer {
  readonly type = 'FEATURE_LISTING' as const;
  readonly shape = 'ROWS' as const;
  /** A row document has no prose sections, so none can be required. */
  readonly requiredSectionKeys = [];

  compose(context: UpstreamContext): ComposedContent {
    /*
     * Keyed by the stored id, because that is what an estimate unit cites. The
     * rows then carry the human-facing `key` (REQ-004), which is what coverage
     * and the client-facing document work in.
     */
    const byId = new Map(context.requirements.map((requirement) => [requirement.id, requirement]));

    const features = this.buildableUnits(context).map((unit, index) => {
      const requirements = unit.requirementIds
        .map((id) => byId.get(id))
        .filter((requirement): requirement is RequirementItem => requirement !== undefined);

      const effort = aggregateFeatureEffort([{ effort: unit.effort }]);

      return {
        requirementIds: requirements.map((requirement) => requirement.key),
        module: this.moduleFor(requirements, unit),
        submodule: '',
        screen: this.screenFor(requirements, context),
        description: this.descriptionFor(requirements, unit),
        effort,
        totalHours: featureTotalHours(effort),
        estimateUnitIds: [unit.id],
        technologyIds: [...this.technologiesFor(context)],
        references: requirements.map(requirementReference),
        reviewStatus: 'GENERATED' as const,
        mappingConfidence: requirements.length > 0 ? 0.8 : 0.2,
        notes: '',
        order: index,
      };
    });

    return { sections: [], features };
  }

  applicableRequirementIds(context: UpstreamContext): readonly string[] {
    /*
     * Functional requirements and business rules. A constraint is not a feature
     * somebody builds, and a listing that demanded a row for "must comply with
     * the client's brand guidelines" would force an invented feature to satisfy
     * coverage — which is the opposite of what coverage is for.
     */
    return context.requirements
      .filter((requirement) => ['functional', 'business_rule'].includes(requirement.category))
      .map((requirement) => requirement.key);
  }

  /** Estimate units that represent buildable features. */
  private buildableUnits(context: UpstreamContext): readonly EstimateUnit[] {
    return context.estimateUnits.filter(
      (unit) => !unit.excluded && !unit.overheadActivity && unit.requirementIds.length > 0,
    );
  }

  /**
   * A module name from the requirement's own words.
   *
   * The first noun-ish fragment of the leading requirement's title, which is
   * usually the subject area — "Timesheet submission" gives "Timesheet". Crude,
   * and honest about being crude: a model does this far better, and when one is
   * available it replaces this. What matters is that the deterministic answer is
   * *derived from the requirement* rather than invented.
   */
  private moduleFor(requirements: readonly RequirementItem[], unit: EstimateUnit): string {
    const title = requirements[0]?.title ?? unit.feature;
    const first = title.split(/[\s,:—-]+/).find((word: string) => word.length > 2);

    return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'General';
  }

  /**
   * A screen, or nothing.
   *
   * Empty is a legitimate and frequent answer. An API-only project has no
   * screens, a background job has no screen, and naming one to fill a column
   * would put a fabrication into a client-facing sheet. So the deterministic
   * answer is empty unless the project actually has an interface *and* the
   * requirement mentions one.
   */
  private screenFor(requirements: readonly RequirementItem[], context: UpstreamContext): string {
    const hasInterface = context.projectTypes.some((type) =>
      /WEB|MOBILE|DESKTOP|PORTAL|DASHBOARD/i.test(type),
    );

    if (!hasInterface) {
      return '';
    }

    const mentioned = requirements.find((requirement) =>
      /\b(screen|page|form|view|dashboard|list|report)\b/i.test(requirement.statement),
    );

    return mentioned ? mentioned.title : '';
  }

  /** The requirement statements, joined with the separator the export uses. */
  private descriptionFor(requirements: readonly RequirementItem[], unit: EstimateUnit): string {
    const points = requirements.map((requirement) => requirement.statement);

    return points.length > 0 ? joinDetailPoints(points) : unit.feature;
  }

  /** Locked-stack components, so a row can be traced to what it is built with. */
  private technologiesFor(context: UpstreamContext): readonly string[] {
    return (context.stack?.components ?? [])
      .map((component) => component.technologyId)
      .filter((id): id is string => typeof id === 'string')
      .slice(0, 40);
  }

  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const approved = new Set(input.context.requirements.map((requirement) => requirement.key));

    /* 1. Every row cites requirements that exist and are not rejected. */
    const citedByRows = input.features.flatMap((row) => row.requirementIds);
    const unknown = [...new Set(citedByRows)].filter((key) => !approved.has(key));
    const rejected = input.context.allRequirements.filter(
      (requirement) => requirement.status === 'rejected' && citedByRows.includes(requirement.key),
    );

    if (unknown.length > 0) {
      findings.push({
        kind: 'unknown_requirement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknown.length} feature${unknown.length === 1 ? '' : 's'} cite${unknown.length === 1 ? 's' : ''} a requirement that is not in your baseline.`,
        action: 'Regenerate the listing so every row traces to an approved requirement.',
        subjectIds: unknown,
      });
    }

    if (rejected.length > 0) {
      findings.push({
        kind: 'rejected_requirement_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${rejected.length} rejected requirement${rejected.length === 1 ? '' : 's'} ${rejected.length === 1 ? 'appears' : 'appear'} in the feature list.`,
        action: 'Regenerate it — a rejected requirement here is work nobody agreed to buy.',
        subjectIds: rejected.map((requirement) => requirement.key),
      });
    }

    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'This listing was built against a baseline that is no longer current.',
        action: 'Regenerate it against the approved baseline as it stands now.',
        subjectIds: [],
      });
    }

    /* 2. Coverage, from disposition and nothing else. */
    const coverage = calculateFeatureCoverage({
      applicableRequirementIds: this.applicableRequirementIds(input.context),
      rows: input.features,
      excludedRequirementIds: input.excludedRequirementIds,
    });

    findings.push(
      coverage.unresolved === 0
        ? {
            kind: 'requirement_uncovered',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: `Every applicable requirement is either in a feature or explicitly excluded (${coverage.percentage}%).`,
            action: '',
            subjectIds: [],
          }
        : {
            kind: 'requirement_uncovered',
            severity: 'BLOCKING',
            detectedBy: 'DETERMINISTIC',
            summary: `${coverage.unresolved} requirement${coverage.unresolved === 1 ? ' is' : 's are'} in no feature and not excluded — coverage is ${coverage.percentage}%, not complete.`,
            action: 'Add a feature for each, or mark it not applicable with a reason.',
            subjectIds: [...coverage.unresolvedRequirementIds],
          },
    );

    if (coverage.unsupportedRows > 0) {
      findings.push({
        kind: 'unsupported_statement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${coverage.unsupportedRows} feature row${coverage.unsupportedRows === 1 ? '' : 's'} cite${coverage.unsupportedRows === 1 ? 's' : ''} no approved requirement.`,
        action: 'Remove them, or map them to the requirements they implement.',
        subjectIds: [...coverage.unsupportedFeatureIds],
      });
    }

    /* 3. The hours are the estimate's hours. */
    const reconciliation = reconcileFeatureEffort({
      estimateUnits: this.buildableUnits(input.context).map((unit) => ({
        id: unit.id,
        totalHours: unit.totalHours,
        excluded: unit.excluded,
      })),
      rows: input.features,
    });

    if (reconciliation.unknownUnitIds.length > 0) {
      findings.push({
        kind: 'unknown_estimate_reference',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${reconciliation.unknownUnitIds.length} row${reconciliation.unknownUnitIds.length === 1 ? '' : 's'} cite${reconciliation.unknownUnitIds.length === 1 ? 's' : ''} an estimate line that is not in the approved estimate.`,
        action: 'Regenerate the listing against the approved estimate.',
        subjectIds: [...reconciliation.unknownUnitIds],
      });
    }

    findings.push(
      reconciliation.reconciles
        ? {
            kind: 'effort_mismatch',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: `The hours here total ${reconciliation.documentHours}, matching the approved estimate exactly.`,
            action: '',
            subjectIds: [],
          }
        : {
            kind: 'effort_mismatch',
            severity: 'BLOCKING',
            detectedBy: 'DETERMINISTIC',
            summary: `The hours here total ${reconciliation.documentHours} against ${reconciliation.estimateHours} in the approved estimate.`,
            action:
              'Regenerate the listing. Hours are changed in the estimation step, never here, so a mismatch means this sheet is quoting an older estimate.',
            subjectIds: [...reconciliation.unknownUnitIds, ...reconciliation.uncitedUnitIds].slice(
              0,
              200,
            ),
          },
    );

    /* 4. Rows that duplicate each other, and a hierarchy that contradicts itself. */
    const duplicates = findDuplicateFeatures(input.features);

    if (duplicates.length > 0) {
      findings.push({
        kind: 'duplicate_content',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${duplicates.length} set${duplicates.length === 1 ? '' : 's'} of rows describe the same feature.`,
        action: 'Merge or remove the duplicates — a client counts rows.',
        subjectIds: duplicates.flat(),
      });
    }

    const hierarchy = inconsistentHierarchy(input.features);

    if (hierarchy.length > 0) {
      findings.push({
        kind: 'inconsistent_hierarchy',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${hierarchy.map((entry) => `"${entry.submodule}"`).join(', ')} appears under more than one module.`,
        action: 'Rename one of them, or move the rows — the exported sheet groups by module.',
        subjectIds: hierarchy.map((entry) => entry.submodule),
      });
    }

    /* 5. Technologies cited are in the locked stack. */
    const locked = new Set(
      (input.context.stack?.components ?? [])
        .map((component) => component.technologyId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const strayTechnologies = [
      ...new Set(input.features.flatMap((row) => row.technologyIds)),
    ].filter((id) => !locked.has(id));

    if (strayTechnologies.length > 0) {
      findings.push({
        kind: 'unknown_technology_reference',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${strayTechnologies.length} technolog${strayTechnologies.length === 1 ? 'y is' : 'ies are'} cited that ${strayTechnologies.length === 1 ? 'is' : 'are'} not in the locked stack.`,
        action: 'Regenerate the listing — the locked stack is what this document may cite.',
        subjectIds: strayTechnologies,
      });
    }

    return findings;
  }

  /** Public, because the engine needs the same set for coverage and reconciliation. */
  coverageFor(context: UpstreamContext, rows: readonly FeatureRow[], excluded: readonly string[]) {
    return calculateFeatureCoverage({
      applicableRequirementIds: this.applicableRequirementIds(context),
      rows,
      excludedRequirementIds: excluded,
    });
  }

  reconciliationFor(context: UpstreamContext, rows: readonly FeatureRow[]) {
    return reconcileFeatureEffort({
      estimateUnits: this.buildableUnits(context).map((unit) => ({
        id: unit.id,
        totalHours: unit.totalHours,
        excluded: unit.excluded,
      })),
      rows,
    });
  }

  /** Estimate units this document draws on, exposed for the AI composer. */
  unitsFor(context: UpstreamContext, requirementIds: readonly string[]): readonly EstimateUnit[] {
    return unitsForRequirements(this.buildableUnits(context), requirementIds);
  }
}
