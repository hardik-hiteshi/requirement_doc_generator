import { Injectable } from '@nestjs/common';
import {
  calculateAlignment,
  calculateBlockers,
  calculateCoverage,
  type AmbiguityFinding,
  type Baseline,
  type BlockDispositionRecord,
  type Clarification,
  type Conflict,
  type DuplicateGroup,
  type MissingInfoFinding,
  type RequirementItem,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { AnalysisRepository } from './analysis.repository';
import { EvidenceLoader } from './pipeline/evidence-loader.service';
import { EvidenceService } from './pipeline/evidence.service';
import {
  toAmbiguity,
  toConflict,
  toDuplicate,
  toGap,
  toItem,
  toClarification,
} from './analysis.mapper';

/**
 * Everything a baseline claims about itself, recomputed from stored records.
 *
 * The numbers are never carried forward and never patched incrementally. Every
 * time something changes — a conflict resolved, a requirement accepted, a
 * question answered — coverage, alignment and the blocker list are calculated
 * again from what is actually in the database.
 *
 * That is more work than adjusting a counter, and it is the right trade. An
 * incrementally-maintained completeness figure is one missed update away from
 * being a confident lie, and this particular number appears next to a button
 * that says *Approve*.
 */
@Injectable()
export class BaselineService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly loader: EvidenceLoader,
    private readonly evidence: EvidenceService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Rebuilds a draft baseline's derived state.
   *
   * Also rescores every requirement, because evidence confidence depends on
   * things outside the requirement itself: whether it is in an open conflict,
   * whether a clarification supporting it was answered, whether a person has
   * accepted it. A score computed once and left alone becomes a stale number
   * presented as a current one.
   *
   * Refuses to touch an approved baseline. What was signed stays signed.
   */
  async refresh(projectId: string, now: Date): Promise<Baseline | null> {
    const baseline = await this.repository.currentBaseline(projectId);

    if (!baseline || baseline.status === 'approved' || baseline.status === 'outdated') {
      return baseline ? toBaseline(baseline) : null;
    }

    const state = await this.loadState(projectId);
    const context = await this.loader.buildContext(projectId);

    for (const item of state.items) {
      const rescored = this.evidence.rescore(
        item,
        context,
        {
          hasConfirmedClarification: state.clarifications.some(
            (clarification) =>
              clarification.relatedItemIds.includes(item.id) &&
              (clarification.status === 'answered' || clarification.status === 'integrated'),
          ),
          humanReviewed: item.status === 'accepted' || item.editedByUser,
          inOpenConflict: state.conflicts.some(
            (conflict) => conflict.status === 'open' && conflict.itemIds.includes(item.id),
          ),
          hasOpenAmbiguity: state.ambiguities.some(
            (ambiguity) => ambiguity.status === 'open' && ambiguity.itemId === item.id,
          ),
        },
        now,
      );

      if (rescored.score !== item.evidenceConfidence.score) {
        await this.repository.setItemEvidence(projectId, item.id, rescored);
      }

      // The in-memory copy is updated too, so the alignment computed below uses
      // the new scores rather than the ones this call just replaced.
      (item as { evidenceConfidence: typeof rescored }).evidenceConfidence = rescored;
    }

    const dispositions = (baseline.dispositions ?? []) as unknown as BlockDispositionRecord[];
    const sources = await this.loader.loadReviewed(projectId);
    const coverage = calculateCoverage(
      dispositions,
      sources.map((source) => ({
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        blockCount: source.blocks.length,
      })),
    );

    const alignment = calculateAlignment({ ...state, coverage });
    const blockers = calculateBlockers({
      ...state,
      coverage,
      knownSourceIds: [...context.sources.keys()],
    });

    const inBaseline = state.items.filter(
      (item) => item.status === 'draft' || item.status === 'accepted' || item.status === 'edited',
    );

    await this.repository.refreshBaseline(projectId, baseline.baselineId, {
      itemIds: inBaseline.map((item) => item.id),
      itemCount: inBaseline.length,
      categoryCounts: countByCategory(inBaseline),
      coverage: coverage,
      alignment: alignment,
      blockers: blockers,
    });

    const refreshed = await this.repository.currentBaseline(projectId);

    return refreshed ? toBaseline(refreshed) : null;
  }

  /**
   * Marks an approved baseline out of date when the sources have moved on.
   *
   * Compares the digest of what is currently reviewed against the digest the
   * baseline was built from. One string comparison, no re-reading, and no
   * heuristic about what counts as a meaningful change — anything that would
   * alter the analysis alters the digest.
   *
   * Nothing about the baseline's content changes. It still says what it said
   * when it was approved; only the world around it moved.
   */
  async propagateOutdated(projectId: string, now: Date, correlationId?: string): Promise<boolean> {
    const baseline = await this.repository.currentBaseline(projectId);

    if (baseline?.status !== 'approved') {
      return false;
    }

    const sources = await this.loader.loadReviewed(projectId);
    const digest = this.loader.digest(sources);

    if (digest === baseline.contentDigest) {
      return false;
    }

    const before = new Set(
      (baseline.coverage as { bySource?: { sourceId: string }[] })?.bySource?.map(
        (entry) => entry.sourceId,
      ) ?? [],
    );
    const after = new Set(sources.map((source) => source.sourceId));

    const reason =
      after.size > before.size
        ? 'source_added'
        : after.size < before.size
          ? 'source_removed'
          : 'source_content_changed';

    await this.repository.markOutdated(projectId, baseline.baselineId, reason, now);

    // On the record. An approved document quietly changing status is exactly
    // the kind of event somebody asks about six months later.
    await this.audit.record({
      type: 'BASELINE_OUTDATED',
      projectId,
      ...(correlationId ? { correlationId } : {}),
      reason,
      metadata: { baselineId: baseline.baselineId, version: baseline.version },
    });

    return true;
  }

  /** Everything the calculations read, in one place. */
  async loadState(projectId: string): Promise<BaselineState> {
    const [items, findings, clarifications] = await Promise.all([
      this.repository.listItems(projectId),
      this.repository.listFindings(projectId),
      this.repository.listClarifications(projectId),
    ]);

    return {
      items: items.map(toItem),
      conflicts: findings.filter((finding) => finding.type === 'conflict').map(toConflict),
      duplicates: findings.filter((finding) => finding.type === 'duplicate').map(toDuplicate),
      ambiguities: findings.filter((finding) => finding.type === 'ambiguity').map(toAmbiguity),
      missing: findings.filter((finding) => finding.type === 'missing').map(toGap),
      clarifications: clarifications.map(toClarification),
    };
  }
}

export interface BaselineState {
  readonly items: RequirementItem[];
  readonly conflicts: Conflict[];
  readonly duplicates: DuplicateGroup[];
  readonly ambiguities: AmbiguityFinding[];
  readonly missing: MissingInfoFinding[];
  readonly clarifications: Clarification[];
}

export function countByCategory(items: readonly RequirementItem[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of items) {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }

  return counts;
}

/** A stored baseline as the contract describes it. */
export function toBaseline(record: {
  baselineId: string;
  projectId: string;
  runId: string;
  version: number;
  status: string;
  itemIds: string[];
  itemCount: number;
  categoryCounts: Record<string, number>;
  coverage: Record<string, unknown>;
  alignment: Record<string, unknown>;
  blockers: Record<string, unknown>[];
  contentDigest: string;
  approvedAt?: Date;
  approvalNote?: string;
  outdatedReason?: string;
  outdatedAt?: Date;
  supersededByVersion?: number;
  createdAt?: Date;
  updatedAt?: Date;
  recordVersion: number;
}): Baseline {
  return {
    id: record.baselineId,
    projectId: record.projectId,
    runId: record.runId,
    version: record.version,
    status: record.status as Baseline['status'],
    itemIds: record.itemIds,
    itemCount: record.itemCount,
    categoryCounts: record.categoryCounts,
    coverage: record.coverage as unknown as Baseline['coverage'],
    alignment: record.alignment as unknown as Baseline['alignment'],
    blockers: record.blockers as unknown as Baseline['blockers'],
    contentDigest: record.contentDigest,
    ...(record.approvedAt ? { approvedAt: record.approvedAt.toISOString() } : {}),
    ...(record.approvalNote ? { approvalNote: record.approvalNote } : {}),
    ...(record.outdatedReason
      ? { outdatedReason: record.outdatedReason as Baseline['outdatedReason'] }
      : {}),
    ...(record.outdatedAt ? { outdatedAt: record.outdatedAt.toISOString() } : {}),
    ...(record.supersededByVersion ? { supersededByVersion: record.supersededByVersion } : {}),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? new Date()).toISOString(),
    recordVersion: record.recordVersion,
  };
}
