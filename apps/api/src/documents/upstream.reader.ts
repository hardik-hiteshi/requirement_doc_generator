import { Injectable } from '@nestjs/common';
import {
  currentnessFrom,
  documentOutdatedReasons,
  isAuthoritativeState,
  DOCUMENT_DEPENDENCIES,
  SETTLED_CLARIFICATION_STATUSES,
  type AcceptanceCriterion,
  type Assumption,
  type ClientDependency,
  type DocumentOutdatedReason,
  type DocumentState,
  type DocumentStatus,
  type DocumentType,
  type Milestone,
  type RequirementItem,
  type ScheduledTask,
  type SowTimeline,
  type WorkPackage,
} from '@wdrg/contracts';

import { AnalysisRepository } from '../analysis/analysis.repository';
import { BaselineService } from '../analysis/baseline.service';
import { EstimationRepository } from '../estimation/estimation.repository';
import { toUnit } from '../estimation/estimation.mapper';
import { ProjectRepository } from '../projects/project.repository';
import { StackRepository } from '../stack/stack.repository';
import { DocumentsRepository } from './documents.repository';
import { toFeatureRow } from './documents.mapper';
import type { UpstreamContext, UpstreamDocuments, UpstreamPlan } from './composers/composer.types';

export interface UpstreamSnapshot {
  readonly context: UpstreamContext;
  /** Whether the approved baseline is still the current one. */
  readonly baselineCurrent: boolean;
  /**
   * Every document's lifecycle status *and* currentness, for lock and blocker
   * checks. Both, because a prerequisite that is approved but stale is not a
   * foundation for the document after it.
   */
  readonly documentStates: Readonly<Partial<Record<DocumentType, DocumentState>>>;
}

/** The upstream versions a document's currentness is judged against. */
export interface AuthorityVersions {
  readonly baselineVersion?: number;
  readonly stackVersion?: number;
  readonly estimateVersion?: number;
  /** False when Phase 4 has marked the approved baseline stale in place. */
  readonly baselineCurrent: boolean;
}

/** What a currentness judgement needs from a stored document. */
export interface DocumentAuthorityRecord {
  readonly type: string;
  readonly baselineVersion?: number;
  readonly stackVersion?: number;
  readonly estimateVersion?: number;
  readonly outdatedReasons: readonly unknown[];
}

/**
 * Every reason a document is no longer current.
 *
 * Exported and shared rather than living in the service, because the reader
 * computes it for *other* documents (to decide whether they unlock this one) and
 * the engine computes it for *this* one. Two implementations of the same
 * judgement is how a list that says "approved" ends up beside a detail view that
 * says "out of date".
 *
 * Nothing here recalculates content. An out-of-date document keeps saying exactly
 * what it said; these are the facts a reader should be told.
 */
export function documentOutdatedReasonsFor(
  record: DocumentAuthorityRecord,
  current: AuthorityVersions,
): readonly DocumentOutdatedReason[] {
  const type = record.type as DocumentType;

  return [
    ...documentOutdatedReasons({
      type,
      generatedAgainst: {
        ...(record.baselineVersion !== undefined
          ? { baselineVersion: record.baselineVersion }
          : {}),
        ...(record.stackVersion !== undefined ? { stackVersion: record.stackVersion } : {}),
        ...(record.estimateVersion !== undefined
          ? { estimateVersion: record.estimateVersion }
          : {}),
      },
      current: {
        ...(current.baselineVersion !== undefined
          ? { baselineVersion: current.baselineVersion }
          : {}),
        ...(current.stackVersion !== undefined ? { stackVersion: current.stackVersion } : {}),
        ...(current.estimateVersion !== undefined
          ? { estimateVersion: current.estimateVersion }
          : {}),
      },
      changedPrerequisites: [],
    }),
    /*
     * A baseline that went out of date without changing version. Phase 4 keeps an
     * approved-then-outdated baseline at the same version until a new analysis run
     * supersedes it, so a version comparison cannot see this — and a document built
     * on it is nonetheless no longer current.
     */
    ...(!current.baselineCurrent &&
    DOCUMENT_DEPENDENCIES[type].upstream.includes('REQUIREMENT_BASELINE') &&
    record.baselineVersion !== undefined
      ? [
          {
            cause: 'baseline_changed' as const,
            summary:
              'The approved requirements are no longer current — something changed upstream after this document was written.',
            generatedAgainst: `v${record.baselineVersion}`,
          },
        ]
      : []),
    /* Prerequisite changes are recorded on the document as they happen. */
    ...(record.outdatedReasons as readonly DocumentOutdatedReason[]),
  ];
}

/**
 * Reads every approved upstream artifact, once per operation.
 *
 * Isolated from the engine so the engine has no opinion about *where* authority
 * comes from — and so the four upstream phases can be read through their own
 * services rather than reached into.
 *
 * Two things this does that a direct repository read would not.
 *
 * **The baseline goes through `BaselineService`.** Phase 4's lazy outdated check
 * runs there, so a baseline that went stale since the last request is reported as
 * stale here. Phases 5 and 6 both learned this the hard way.
 *
 * **Only approved, non-rejected, non-superseded requirements reach a composer.**
 * `allRequirements` carries the rest, because validation has to be able to notice
 * a rejected requirement appearing in a document — it cannot check for something
 * it was never shown.
 */
@Injectable()
export class UpstreamReader {
  constructor(
    private readonly analysis: AnalysisRepository,
    private readonly baselines: BaselineService,
    private readonly stacks: StackRepository,
    private readonly estimates: EstimationRepository,
    private readonly projects: ProjectRepository,
    private readonly documents: DocumentsRepository,
  ) {}

  async read(projectId: string, correlationId: string): Promise<UpstreamSnapshot> {
    await this.baselines.propagateOutdated(projectId, new Date(), correlationId);

    const project = await this.projects.findByProjectId(projectId);
    const baselines = await this.analysis.listBaselines(projectId);
    const approved = baselines.find(
      (baseline) => baseline.status === 'approved' || baseline.status === 'outdated',
    );

    /*
     * Mapped field by field rather than through `toObject`. The stored id is
     * `itemId`, and a spread would leave `id` undefined — which silently emptied
     * every section, because nothing matched the baseline's `itemIds`.
     */
    const items = await this.analysis.listItems(projectId);
    const allRequirements = items.map((item) => ({
      ...(item.toObject({ getters: false }) as unknown as RequirementItem),
      id: item.itemId,
    }));

    const inBaseline = new Set(approved?.itemIds ?? []);
    const requirements = allRequirements.filter(
      (requirement) =>
        inBaseline.has(requirement.id) &&
        requirement.status !== 'rejected' &&
        requirement.status !== 'superseded',
    );

    const allClarifications = await this.analysis.listClarifications(projectId);

    /*
     * Requirement keys, not internal ids. A clarification stores `relatedItemIds`,
     * and a document cites `REQ-004` — the ids mean nothing to a reader and nothing
     * to the citation checks, which compare against keys.
     */
    const keyById = new Map(
      allRequirements.map((requirement) => [requirement.id, requirement.key]),
    );

    const openClarifications = allClarifications
      .filter((clarification) => clarification.status === 'UNANSWERED')
      .map((clarification) => ({
        id: clarification.clarificationId,
        label: clarification.key,
        question: clarification.question,
        requirementIds: clarification.relatedItemIds
          .map((id) => keyById.get(id))
          .filter((key): key is string => key !== undefined),
        blocking: clarification.impact === 'blocking',
      }));

    const clarifications = allClarifications
      .filter((clarification) =>
        (SETTLED_CLARIFICATION_STATUSES as readonly string[]).includes(clarification.status),
      )
      .map((clarification) => {
        const answers = clarification.answers as {
          text?: string;
          isAssumption?: boolean;
          confirmedAt?: Date;
        }[];
        const current = answers.at(-1);

        return {
          id: clarification.clarificationId,
          label: clarification.key,
          question: clarification.question,
          answer: current?.text ?? '',
          /*
           * Phase 4 asked the user, at the time they answered, whether this was the
           * client's fact or their own assumption. That answer is the authoritative
           * provenance for Document 4 — the one place an assumption can come from
           * without anybody being asked again.
           */
          isAssumption: current?.isAssumption === true,
          confirmed: current?.confirmedAt !== undefined,
        };
      })
      .filter((entry) => entry.answer.length > 0);

    const stackSnapshot = await this.stacks.currentSnapshot(projectId);
    const locked = stackSnapshot?.status === 'LOCKED' ? stackSnapshot : null;
    const components = locked ? await this.stacks.listComponents(projectId, locked.version) : [];

    const estimateSnapshot = await this.estimates.currentSnapshot(projectId);
    /*
     * Only an approved estimate is authority. A draft estimate's hours are still
     * being argued about, and a Feature Listing quoting them would put figures in
     * front of a client that nobody has signed off.
     */
    const approvedEstimate = estimateSnapshot?.status === 'APPROVED' ? estimateSnapshot : null;
    const estimateUnits = approvedEstimate
      ? (await this.estimates.listUnits(projectId, approvedEstimate.version)).map(toUnit)
      : [];

    const documentRecords = await this.documents.findAll(projectId);

    const baselineCurrent = approved?.status === 'approved';
    const approvedBaselineVersion = approved?.version;
    const lockedStackVersion = locked?.version;
    const approvedEstimateVersion = approvedEstimate?.version;

    return {
      context: {
        projectId,
        projectName: project?.name ?? 'This project',
        projectTypes: project?.projectTypes ?? [],
        baseline: approved
          ? {
              id: approved.baselineId,
              version: approved.version,
              status: approved.status,
              itemIds: [...approved.itemIds],
            }
          : null,
        requirements,
        allRequirements,
        clarifications,
        openClarifications,
        stack: locked
          ? {
              id: locked.snapshotId,
              version: locked.version,
              status: locked.status,
              components: components.map((component) => ({
                category: component.category,
                ...(component.technologyId ? { technologyId: component.technologyId } : {}),
                technologyName: component.technologyName,
                status: component.status,
              })),
            }
          : null,
        estimate: approvedEstimate
          ? {
              id: approvedEstimate.snapshotId,
              version: approvedEstimate.version,
              status: approvedEstimate.status,
            }
          : null,
        estimateUnits: estimateUnits,
        upstreamBlockers: (approvedEstimate?.blockers ?? []).map((blocker) => ({
          kind: String((blocker as { kind?: string }).kind ?? 'unknown'),
          summary: String((blocker as { summary?: string }).summary ?? ''),
        })),
        timeline: approvedEstimate ? this.timelineFrom(approvedEstimate, project) : null,
        plan: approvedEstimate ? this.planFrom(approvedEstimate) : null,
        documents: await this.approvedDocuments(projectId, documentRecords, {
          ...(approvedBaselineVersion !== undefined
            ? { baselineVersion: approvedBaselineVersion }
            : {}),
          ...(lockedStackVersion !== undefined ? { stackVersion: lockedStackVersion } : {}),
          ...(approvedEstimateVersion !== undefined
            ? { estimateVersion: approvedEstimateVersion }
            : {}),
          baselineCurrent,
        }),
      },
      baselineCurrent,
      documentStates: Object.fromEntries(
        documentRecords.map((record) => [
          record.type,
          {
            status: record.status as DocumentStatus,
            currentness: currentnessFrom(
              documentOutdatedReasonsFor(record, {
                ...(approvedBaselineVersion !== undefined
                  ? { baselineVersion: approvedBaselineVersion }
                  : {}),
                ...(lockedStackVersion !== undefined ? { stackVersion: lockedStackVersion } : {}),
                ...(approvedEstimateVersion !== undefined
                  ? { estimateVersion: approvedEstimateVersion }
                  : {}),
                baselineCurrent,
              }),
            ),
          },
        ]),
      ),
    };
  }

  /**
   * The approved schedule, in the terms a document may quote.
   *
   * `basis` is the whole point. A document may name a date only when the project
   * has one, and this is where that is decided — from the project's own start-date
   * mode and the client's deadline, not from a composer's guess. `RELATIVE` means
   * there is no date to name and the document must say "following commencement".
   */
  private timelineFrom(
    estimate: {
      schedule?: Record<string, unknown>;
      feasibility?: Record<string, unknown>;
      acknowledgedFeasibility?: string;
    },
    project: { timeline?: Record<string, unknown>; startDate?: Record<string, unknown> } | null,
  ): SowTimeline {
    const schedule = (estimate.schedule ?? {}) as {
      totalWorkingDays?: number;
      startDate?: string;
      relativeOnly?: boolean;
    };
    const timeline = (project?.timeline ?? {}) as { mode?: string; deadline?: string };
    const feasibility = (estimate.feasibility ?? {}) as { status?: string };

    const workingDays = schedule.totalWorkingDays ?? 0;
    /* Five working days to the week, which is what Phase 6's calendar assumes. */
    const workingWeeks = workingDays > 0 ? Math.ceil(workingDays / 5) : undefined;

    const basis: SowTimeline['basis'] =
      timeline.mode === 'FIXED_DEADLINE' && timeline.deadline
        ? 'FIXED_DEADLINE'
        : schedule.startDate
          ? 'ABSOLUTE_START'
          : 'RELATIVE';

    return {
      basis,
      ...(workingWeeks !== undefined ? { workingWeeks } : {}),
      ...(workingDays > 0 ? { workingDays } : {}),
      ...(schedule.startDate ? { startDate: schedule.startDate } : {}),
      ...(timeline.deadline ? { deadline: timeline.deadline } : {}),
      ...(feasibility.status ? { feasibility: feasibility.status } : {}),
      /*
       * An estimate approved despite a high-risk verdict. The SOW states the
       * approved timeline and the risk; it does not quietly substitute a safer
       * date, which would be this application deciding a commercial question.
       */
      acknowledgedRisk: Boolean(estimate.acknowledgedFeasibility),
    };
  }

  /**
   * The approved plan, read straight off the snapshot.
   *
   * Phase 6's `approve` persists the totals, the schedule and the milestones as they
   * stood, which is what makes this a read rather than a recalculation — and what
   * lets the Work Breakdown Structure be a projection of an approved plan instead of
   * a second opinion about it.
   */
  private planFrom(estimate: {
    schedule?: Record<string, unknown>;
    milestones?: Record<string, unknown>[];
    effortByRole?: Record<string, unknown>;
    totalEffort?: Record<string, unknown>;
  }): UpstreamPlan {
    const schedule = (estimate.schedule ?? {}) as {
      tasks?: ScheduledTask[];
      totalWorkingDays?: number;
      criticalPath?: string[];
      startDate?: string;
      finishDate?: string;
      relativeOnly?: boolean;
    };

    const effortByRole = Object.fromEntries(
      Object.entries(estimate.effortByRole ?? {}).map(([role, hours]) => [
        role,
        Number(hours) || 0,
      ]),
    );

    const total = (estimate.totalEffort ?? {}) as { hours?: number };

    return {
      effortByRole,
      totalHours:
        typeof total.hours === 'number'
          ? total.hours
          : Object.values(effortByRole).reduce((sum, hours) => sum + hours, 0),
      tasks: schedule.tasks ?? [],
      milestones: (estimate.milestones ?? []) as unknown as Milestone[],
      criticalPath: schedule.criticalPath ?? [],
      totalWorkingDays: schedule.totalWorkingDays ?? 0,
      ...(schedule.startDate ? { startDate: schedule.startDate } : {}),
      ...(schedule.finishDate ? { finishDate: schedule.finishDate } : {}),
      /*
       * Absent means relative. A missing flag must not be read as "dates are fine" —
       * that would let the breakdown publish calendar dates for a project with no
       * agreed start.
       */
      relativeOnly: schedule.relativeOnly !== false,
    };
  }

  /**
   * Content of earlier documents, and only where they are authority.
   *
   * A document appears here **only** when it is approved or issued *and* current.
   * That single condition is the sequential rule and the currentness rule at once,
   * expressed as data: a composer for document 5 that finds `assumptions: null`
   * has nothing to build on, and cannot accidentally quote a draft.
   */
  private async approvedDocuments(
    projectId: string,
    records: readonly {
      type: string;
      status: string;
      version: number;
      outdatedReasons: unknown[];
    }[],
    current: AuthorityVersions,
  ): Promise<UpstreamDocuments> {
    const authoritative = new Map<string, { version: number }>();

    for (const record of records) {
      const state = {
        status: record.status as DocumentStatus,
        currentness: currentnessFrom(documentOutdatedReasonsFor(record, current)),
      };

      if (isAuthoritativeState(state)) {
        authoritative.set(record.type, { version: record.version });
      }
    }

    const understanding = authoritative.get('OUR_UNDERSTANDING');
    const featureListing = authoritative.get('FEATURE_LISTING');
    const acceptanceCriteria = authoritative.get('ACCEPTANCE_CRITERIA');
    const assumptions = authoritative.get('ASSUMPTIONS');
    const statementOfWork = authoritative.get('STATEMENT_OF_WORK');
    const workBreakdown = authoritative.get('WORK_BREAKDOWN_STRUCTURE');
    const clientDependencies = authoritative.get('CLIENT_DEPENDENCY_SHEET');

    const [
      understandingSections,
      features,
      criteriaRows,
      assumptionRows,
      exclusions,
      sowSections,
      wbsRows,
      dependencyRows,
    ] = await Promise.all([
      understanding
        ? this.documents.listSections(projectId, 'OUR_UNDERSTANDING', understanding.version)
        : Promise.resolve([]),
      featureListing
        ? this.documents.listFeatures(projectId, 'FEATURE_LISTING', featureListing.version)
        : Promise.resolve([]),
      acceptanceCriteria
        ? this.documents.listRows(projectId, 'ACCEPTANCE_CRITERIA', acceptanceCriteria.version)
        : Promise.resolve([]),
      assumptions
        ? this.documents.listRows(projectId, 'ASSUMPTIONS', assumptions.version)
        : Promise.resolve([]),
      featureListing ? this.documents.find(projectId, 'FEATURE_LISTING') : Promise.resolve(null),
      statementOfWork
        ? this.documents.listSections(projectId, 'STATEMENT_OF_WORK', statementOfWork.version)
        : Promise.resolve([]),
      workBreakdown
        ? this.documents.listRows(projectId, 'WORK_BREAKDOWN_STRUCTURE', workBreakdown.version)
        : Promise.resolve([]),
      clientDependencies
        ? this.documents.listRows(projectId, 'CLIENT_DEPENDENCY_SHEET', clientDependencies.version)
        : Promise.resolve([]),
    ]);

    return {
      understanding: understanding
        ? {
            version: understanding.version,
            sections: understandingSections.map((section) => ({
              key: section.key,
              title: section.title,
              body: section.body,
            })),
          }
        : null,
      featureListing: featureListing
        ? {
            version: featureListing.version,
            features: features.map(toFeatureRow),
            excludedRequirementIds: (exclusions?.exclusions ?? []).map(
              (entry) => entry.requirementId,
            ),
          }
        : null,
      acceptanceCriteria: acceptanceCriteria
        ? {
            version: acceptanceCriteria.version,
            criteria: criteriaRows
              .filter((row) => !row.excludedReason)
              .map((row) => row.payload as unknown as AcceptanceCriterion),
          }
        : null,
      assumptions: assumptions
        ? {
            version: assumptions.version,
            assumptions: assumptionRows.map((row) => row.payload as unknown as Assumption),
          }
        : null,
      statementOfWork: statementOfWork
        ? {
            version: statementOfWork.version,
            sections: sowSections.map((section) => ({
              key: section.key,
              title: section.title,
              body: section.body,
            })),
          }
        : null,
      workBreakdown: workBreakdown
        ? {
            version: workBreakdown.version,
            /*
             * Excluded packages are kept. The dependency sheet needs to know a task
             * was deliberately dropped, so it does not go on asking the client for
             * something nobody is going to build.
             */
            packages: wbsRows.map((row) => row.payload as WorkPackage),
          }
        : null,
      clientDependencies: clientDependencies
        ? {
            version: clientDependencies.version,
            dependencies: dependencyRows
              .filter((row) => !row.excludedReason)
              .map((row) => row.payload as ClientDependency),
          }
        : null,
    };
  }
}
