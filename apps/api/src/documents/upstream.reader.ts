import { Injectable } from '@nestjs/common';
import {
  currentnessFrom,
  documentOutdatedReasons,
  DOCUMENT_DEPENDENCIES,
  SETTLED_CLARIFICATION_STATUSES,
  type DocumentOutdatedReason,
  type DocumentState,
  type DocumentStatus,
  type DocumentType,
  type RequirementItem,
} from '@wdrg/contracts';

import { AnalysisRepository } from '../analysis/analysis.repository';
import { BaselineService } from '../analysis/baseline.service';
import { EstimationRepository } from '../estimation/estimation.repository';
import { toUnit } from '../estimation/estimation.mapper';
import { ProjectRepository } from '../projects/project.repository';
import { StackRepository } from '../stack/stack.repository';
import { DocumentsRepository } from './documents.repository';
import type { UpstreamContext } from './composers/composer.types';

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

    const clarifications = (await this.analysis.listClarifications(projectId))
      .filter((clarification) =>
        (SETTLED_CLARIFICATION_STATUSES as readonly string[]).includes(clarification.status),
      )
      .map((clarification) => {
        const answers = clarification.answers as { text?: string }[];

        return {
          id: clarification.clarificationId,
          label: clarification.key,
          question: clarification.question,
          answer: answers.at(-1)?.text ?? '',
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
}
