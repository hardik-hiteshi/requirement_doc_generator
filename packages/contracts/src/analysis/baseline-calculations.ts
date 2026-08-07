import {
  INCOMPLETE_ALIGNMENT_CAP,
  type Alignment,
  type ApprovalBlocker,
  type BlockerKind,
  type Coverage,
} from './baseline.contract';
import { blocksBaselineApproval, type Clarification } from './clarification.contract';
import type {
  AmbiguityFinding,
  Conflict,
  DuplicateGroup,
  MissingInfoFinding,
} from './findings.contract';
import { isAccountedFor, type BlockDispositionRecord } from './analysis-run.contract';
import { isInBaseline, type RequirementItem } from './requirement-item.contract';

/**
 * What a baseline is allowed to claim about itself.
 *
 * Every number here is computed from stored records by code a person can read.
 * None of it is asked of the model, and none of it is optimistic by default.
 *
 * The rule that shapes all three functions: **a generated baseline does not earn
 * a completeness claim by generating successfully.** A run that produced two
 * hundred requirements and left six conflicts open has not aligned with
 * anything, and a number near 100 beside those six conflicts is not an
 * estimate — it is a false statement in a document a client is being asked to
 * sign.
 */

export interface SourceSummary {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly blockCount: number;
}

/**
 * Coverage: how much of the reviewed evidence was accounted for.
 *
 * Counted in *blocks that received a disposition*, not in requirements found. A
 * model that splits one sentence into four requirements has not covered more of
 * the document; it has produced more rows. Blocks are what the documents are
 * made of, so blocks are what gets counted.
 *
 * "This block states no requirement" counts as accounted for — it is a decision
 * with a recorded reason. "This block was never analysed" does not, and it is
 * the number that matters.
 */
export function calculateCoverage(
  dispositions: readonly BlockDispositionRecord[],
  sources: readonly SourceSummary[],
): Coverage {
  const counts = {
    covered: 0,
    no_requirement: 0,
    duplicate_content: 0,
    not_analysed: 0,
  };

  for (const record of dispositions) {
    counts[record.disposition] += 1;
  }

  const totalBlocks = sources.reduce((total, source) => total + source.blockCount, 0);

  /*
   * Blocks with no disposition record at all are counted as unanalysed rather
   * than ignored. A missing record is exactly the case this number exists to
   * catch: something the pipeline never reached and never reported.
   */
  const recorded = dispositions.length;
  const unrecorded = Math.max(0, totalBlocks - recorded);
  const notAnalysed = counts.not_analysed + unrecorded;
  const accounted = totalBlocks - notAnalysed;

  const bySourceAccounted = new Map<string, number>();

  for (const record of dispositions) {
    if (isAccountedFor(record.disposition)) {
      bySourceAccounted.set(record.sourceId, (bySourceAccounted.get(record.sourceId) ?? 0) + 1);
    }
  }

  return {
    totalBlocks,
    coveredBlocks: counts.covered,
    noRequirementBlocks: counts.no_requirement,
    duplicateContentBlocks: counts.duplicate_content,
    notAnalysedBlocks: notAnalysed,
    ratio: ratio(accounted, totalBlocks),
    bySource: sources.map((source) => {
      const accountedForSource = bySourceAccounted.get(source.sourceId) ?? 0;

      return {
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        totalBlocks: source.blockCount,
        accountedBlocks: accountedForSource,
        ratio: ratio(accountedForSource, source.blockCount),
      };
    }),
  };
}

export interface AlignmentInput {
  readonly items: readonly RequirementItem[];
  readonly coverage: Coverage;
  readonly conflicts: readonly Conflict[];
  readonly duplicates: readonly DuplicateGroup[];
  readonly ambiguities: readonly AmbiguityFinding[];
  readonly missing: readonly MissingInfoFinding[];
  readonly clarifications: readonly Clarification[];
}

/**
 * Alignment: how well the baseline reflects what the documents said.
 *
 * Four components, weighted, then capped. The cap is the part that matters:
 * while anything remains unsettled, `isComplete` is false and `overall` cannot
 * exceed {@link INCOMPLETE_ALIGNMENT_CAP}, no matter how good the components
 * are. The reasons are returned in plain language so the UI shows *why* rather
 * than a bare percentage.
 */
export function calculateAlignment(input: AlignmentInput): Alignment {
  const items = input.items.filter((item) => isInBaseline(item.status));

  const traceable = items.filter((item) =>
    item.references.some((reference) => reference.verified),
  ).length;
  const traceability = ratio(traceable, items.length);

  const evidenceQuality =
    items.length === 0
      ? 0
      : round(
          items.reduce((total, item) => total + item.evidenceConfidence.score, 0) / items.length,
        );

  const findings = [
    ...input.conflicts.map((conflict) => conflict.status),
    ...input.duplicates.map((duplicate) => duplicate.status),
    ...input.ambiguities.map((ambiguity) => ambiguity.status),
    ...input.missing.map((gap) => gap.status),
  ];
  const settledFindings = findings.filter((status) => status !== 'open').length;
  const findingResolution = findings.length === 0 ? 1 : ratio(settledFindings, findings.length);

  const settledClarifications = input.clarifications.filter(
    (clarification) => clarification.status !== 'open',
  ).length;
  const clarificationResolution =
    input.clarifications.length === 0
      ? 1
      : ratio(settledClarifications, input.clarifications.length);

  const incompleteReasons = describeIncompleteness(input, items);
  const isComplete = incompleteReasons.length === 0;

  /*
   * Traceability and evidence quality carry most of the weight because they are
   * about the requirements themselves. Resolution measures work outstanding,
   * which the cap already handles more bluntly.
   */
  const weighted =
    traceability * 0.35 +
    evidenceQuality * 0.35 +
    findingResolution * 0.2 +
    clarificationResolution * 0.1;

  const capped = isComplete ? weighted : Math.min(weighted, INCOMPLETE_ALIGNMENT_CAP);

  return {
    traceability,
    evidenceQuality,
    findingResolution,
    clarificationResolution,
    overall: round(capped),
    isComplete,
    incompleteReasons,
  };
}

function describeIncompleteness(
  input: AlignmentInput,
  items: readonly RequirementItem[],
): string[] {
  const reasons: string[] = [];

  if (items.length === 0) {
    reasons.push('No requirements have been produced yet.');
  }

  if (input.coverage.notAnalysedBlocks > 0) {
    reasons.push(
      `${input.coverage.notAnalysedBlocks} ${plural(input.coverage.notAnalysedBlocks, 'part')} of your documents ${input.coverage.notAnalysedBlocks === 1 ? 'was' : 'were'} never analysed.`,
    );
  }

  const untraceable = items.filter(
    (item) => !item.references.some((reference) => reference.verified),
  ).length;

  if (untraceable > 0) {
    reasons.push(
      `${untraceable} ${plural(untraceable, 'requirement')} cannot be traced to a verified quotation.`,
    );
  }

  const openBlockingConflicts = input.conflicts.filter(
    (conflict) => conflict.status === 'open' && conflict.severity === 'blocking',
  ).length;

  if (openBlockingConflicts > 0) {
    reasons.push(
      `${openBlockingConflicts} blocking ${plural(openBlockingConflicts, 'conflict')} ${openBlockingConflicts === 1 ? 'is' : 'are'} unresolved.`,
    );
  }

  const openBlockingQuestions = input.clarifications.filter(blocksBaselineApproval).length;

  if (openBlockingQuestions > 0) {
    reasons.push(
      `${openBlockingQuestions} ${plural(openBlockingQuestions, 'question')} ${openBlockingQuestions === 1 ? 'needs' : 'need'} an answer.`,
    );
  }

  return reasons;
}

export interface BlockerInput extends AlignmentInput {
  /** Source ids that exist in this project, for detecting invented citations. */
  readonly knownSourceIds: readonly string[];
}

/**
 * Every reason this baseline may not be approved yet.
 *
 * Enumerated rather than judged. A gate whose criteria cannot be listed is a
 * gate nobody can satisfy deliberately, and each blocker therefore names both
 * what is wrong and what to do about it.
 */
export function calculateBlockers(input: BlockerInput): ApprovalBlocker[] {
  const blockers: ApprovalBlocker[] = [];
  const items = input.items.filter((item) => isInBaseline(item.status));
  const known = new Set(input.knownSourceIds);

  if (items.length === 0) {
    blockers.push({
      kind: 'empty_baseline',
      count: 1,
      summary: 'This baseline has no requirements in it.',
      action: 'Run the analysis, or add a requirement by hand.',
      itemIds: [],
      findingIds: [],
    });

    return blockers;
  }

  const untraceable = items.filter((item) => item.references.length === 0);

  if (untraceable.length > 0) {
    blockers.push(
      blocker(
        'untraceable_requirement',
        untraceable.length,
        `${untraceable.length} ${plural(untraceable.length, 'requirement')} ${untraceable.length === 1 ? 'has' : 'have'} no link to any document.`,
        'Open each one and either link it to the text it came from, or reject it.',
        untraceable.map((item) => item.id),
      ),
    );
  }

  const invented = items.filter((item) =>
    item.references.some((reference) => !known.has(reference.sourceId)),
  );

  if (invented.length > 0) {
    blockers.push(
      blocker(
        'hallucinated_reference',
        invented.length,
        `${invented.length} ${plural(invented.length, 'requirement')} cite${invented.length === 1 ? 's' : ''} a document that is not part of this project.`,
        'Reject these. A citation to a document that does not exist cannot be checked.',
        invented.map((item) => item.id),
      ),
    );
  }

  const unsupported = items.filter(
    (item) => item.evidenceConfidence.band === 'unsupported' && item.references.length > 0,
  );

  if (unsupported.length > 0) {
    blockers.push(
      blocker(
        'unsupported_requirement',
        unsupported.length,
        `${unsupported.length} ${plural(unsupported.length, 'requirement')} ${unsupported.length === 1 ? 'has' : 'have'} evidence too weak to rely on.`,
        'Check each against its source, then accept, correct or reject it.',
        unsupported.map((item) => item.id),
      ),
    );
  }

  const blockingConflicts = input.conflicts.filter(
    (conflict) => conflict.status === 'open' && conflict.severity === 'blocking',
  );

  if (blockingConflicts.length > 0) {
    blockers.push({
      kind: 'blocking_conflict',
      count: blockingConflicts.length,
      summary: `${blockingConflicts.length} ${plural(blockingConflicts.length, 'requirement')} ${blockingConflicts.length === 1 ? 'contradicts another' : 'contradict others'}.`,
      action: 'Decide which statement holds, or ask the client. Nothing is chosen automatically.',
      itemIds: blockingConflicts.flatMap((conflict) => conflict.itemIds).slice(0, 100),
      findingIds: blockingConflicts.map((conflict) => conflict.id),
    });
  }

  const openQuestions = input.clarifications.filter(blocksBaselineApproval);

  if (openQuestions.length > 0) {
    blockers.push({
      kind: 'unanswered_clarification',
      count: openQuestions.length,
      summary: `${openQuestions.length} ${plural(openQuestions.length, 'question')} the baseline depends on ${openQuestions.length === 1 ? 'is' : 'are'} unanswered.`,
      action: 'Answer each one, or dismiss it with a reason.',
      itemIds: [],
      findingIds: openQuestions.map((clarification) => clarification.id),
    });
  }

  const openDuplicates = input.duplicates.filter((duplicate) => duplicate.status === 'open');

  if (openDuplicates.length > 0) {
    blockers.push({
      kind: 'open_duplicate',
      count: openDuplicates.length,
      summary: `${openDuplicates.length} possible ${plural(openDuplicates.length, 'duplicate')} ${openDuplicates.length === 1 ? 'has' : 'have'} not been decided.`,
      action: 'Merge each group or keep them separate. Nothing is merged for you.',
      itemIds: [],
      findingIds: openDuplicates.map((duplicate) => duplicate.id),
    });
  }

  const blockingGaps = input.missing.filter(
    (gap) => gap.status === 'open' && gap.blocksImplementation,
  );

  if (blockingGaps.length > 0) {
    blockers.push({
      kind: 'blocking_gap',
      count: blockingGaps.length,
      summary: `${blockingGaps.length} ${plural(blockingGaps.length, 'requirement')} ${blockingGaps.length === 1 ? 'is' : 'are'} missing detail needed to build ${blockingGaps.length === 1 ? 'it' : 'them'}.`,
      action: 'Fill the gap, raise a question about it, or accept it as a known risk.',
      itemIds: blockingGaps.flatMap((gap) => (gap.itemId ? [gap.itemId] : [])).slice(0, 100),
      findingIds: blockingGaps.map((gap) => gap.id),
    });
  }

  if (input.coverage.notAnalysedBlocks > 0) {
    blockers.push({
      kind: 'unanalysed_content',
      count: input.coverage.notAnalysedBlocks,
      summary: `${input.coverage.notAnalysedBlocks} ${plural(input.coverage.notAnalysedBlocks, 'part')} of your documents ${input.coverage.notAnalysedBlocks === 1 ? 'was' : 'were'} never analysed.`,
      action: 'Run the analysis again. Approving now would sign off on content nobody read.',
      itemIds: [],
      findingIds: [],
    });
  }

  return blockers;
}

function blocker(
  kind: BlockerKind,
  count: number,
  summary: string,
  action: string,
  itemIds: readonly string[],
): ApprovalBlocker {
  return {
    kind,
    count,
    summary,
    action,
    itemIds: itemIds.slice(0, 100),
    findingIds: [],
  };
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : round(part / total);
}

function round(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
