import {
  requirementKey,
  type BlockDisposition,
  type BlockDispositionRecord,
  type DuplicateKind,
  type RequirementCategory,
  type RequirementPriority,
} from '@wdrg/contracts';

import { baseBlockId } from './chunker';
import {
  EXACT_DUPLICATE_THRESHOLD,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeForComparison,
  similarity,
} from './text-similarity';

/**
 * Putting the chunks back together.
 *
 * Chunking makes analysis possible; this is what makes it *correct*. A chunk
 * knows only what it contained, so three kinds of truth are invisible to every
 * chunk individually and visible only here:
 *
 * - the same requirement extracted twice, from two chunks of the same document;
 * - the same requirement stated in two different documents;
 * - a block that no chunk produced anything from, which is a coverage gap
 *   rather than an absence of news.
 *
 * The last one is the reason this stage assigns dispositions. A requirement
 * mentioned in file A and contradicted in file B must surface as a conflict
 * rather than whichever chunk happened to run last quietly winning — and that
 * only works if both survive reconciliation to be compared.
 *
 * **Nothing is merged here.** Exact and near duplicates are *grouped*, with a
 * suggestion, and a person decides. Deterministic detection is about finding
 * them reliably, not about acting on them.
 */

export interface CandidateItem {
  /** Chunk-local id, from the model. Unique only within its chunk. */
  readonly localId: string;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly title: string;
  readonly statement: string;
  readonly category: RequirementCategory;
  readonly nfrDimension?: string;
  readonly priority: RequirementPriority;
  readonly modelConfidence: number;
  readonly evidence: readonly { blockId: string; excerpt: string }[];
}

export interface ReconciledItem extends CandidateItem {
  /** Assigned here, unique within the run, and stable in reading order. */
  readonly key: string;
  /** Every chunk that produced this item. More than one means it recurred. */
  readonly chunkIds: readonly string[];
}

export interface DeterministicDuplicate {
  readonly kind: DuplicateKind;
  readonly keys: readonly string[];
  readonly similarity: number;
  readonly crossChunk: boolean;
  readonly crossSource: boolean;
  readonly rationale: string;
}

export interface ReconciliationInput {
  readonly candidates: readonly CandidateItem[];
  /** Blocks the model read and judged to hold no requirement, with reasons. */
  readonly nonRequirementBlocks: readonly {
    chunkId: string;
    sourceId: string;
    blockId: string;
    reason: string;
  }[];
  /** Every block that went into a chunk, by source. */
  readonly analysedBlocks: readonly { sourceId: string; blockId: string; chunkId: string }[];
  /** Blocks that never reached a chunk, or whose chunk failed. */
  readonly unanalysedBlocks: readonly { sourceId: string; blockId: string }[];
}

export interface ReconciliationResult {
  readonly items: readonly ReconciledItem[];
  readonly duplicates: readonly DeterministicDuplicate[];
  readonly dispositions: readonly BlockDispositionRecord[];
}

/**
 * Combines every chunk's candidates into one set with global identity.
 *
 * Ordering is by chunk index then by position within the chunk, so keys run in
 * reading order — REQ-001 is the first requirement in the first document, which
 * is what a reader expects and what makes a key worth citing.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const items: ReconciledItem[] = [];
  const byNormalizedText = new Map<string, string[]>();

  input.candidates.forEach((candidate, index) => {
    const key = requirementKey(index + 1);

    items.push({ ...candidate, key, chunkIds: [candidate.chunkId] });

    const normalized = normalizeForComparison(candidate.statement);
    byNormalizedText.set(normalized, [...(byNormalizedText.get(normalized) ?? []), key]);
  });

  return {
    items,
    duplicates: findDuplicates(items, byNormalizedText),
    dispositions: assignDispositions(input, items),
  };
}

/**
 * Exact and near duplicates, found by comparison rather than by asking.
 *
 * The model is asked separately about *restated* duplicates — different words,
 * same requirement — because that needs understanding. These two kinds do not,
 * and computing them means the obvious cases are caught every time rather than
 * whenever a small model happens to notice.
 */
function findDuplicates(
  items: readonly ReconciledItem[],
  byNormalizedText: ReadonlyMap<string, readonly string[]>,
): DeterministicDuplicate[] {
  const duplicates: DeterministicDuplicate[] = [];
  const grouped = new Set<string>();
  const byKey = new Map(items.map((item) => [item.key, item]));

  for (const [, keys] of byNormalizedText) {
    if (keys.length < 2) {
      continue;
    }

    for (const key of keys) {
      grouped.add(key);
    }

    duplicates.push(describe('exact', keys, EXACT_DUPLICATE_THRESHOLD, byKey));
  }

  /*
   * Near duplicates: an O(n²) sweep over what is left. With the item ceiling at
   * 2,000 that is four million comparisons of small token sets — under a second,
   * and orders of magnitude cheaper than one inference call. Anything cleverer
   * would be a cache to keep correct for no measurable gain.
   */
  const remaining = items.filter((item) => !grouped.has(item.key));

  for (let i = 0; i < remaining.length; i += 1) {
    const left = remaining[i];

    if (!left || grouped.has(left.key)) {
      continue;
    }

    const matches: string[] = [];
    let best = 0;

    for (let j = i + 1; j < remaining.length; j += 1) {
      const right = remaining[j];

      if (!right || grouped.has(right.key)) {
        continue;
      }

      const score = similarity(left.statement, right.statement);

      if (score >= NEAR_DUPLICATE_THRESHOLD) {
        matches.push(right.key);
        best = Math.max(best, score);
      }
    }

    if (matches.length > 0) {
      const keys = [left.key, ...matches];

      for (const key of keys) {
        grouped.add(key);
      }

      duplicates.push(describe('near', keys, best, byKey));
    }
  }

  return duplicates;
}

function describe(
  kind: DuplicateKind,
  keys: readonly string[],
  score: number,
  byKey: ReadonlyMap<string, ReconciledItem>,
): DeterministicDuplicate {
  const members = keys.flatMap((key) => {
    const item = byKey.get(key);

    return item ? [item] : [];
  });

  const sources = new Set(members.map((item) => item.sourceId));
  const chunks = new Set(members.map((item) => item.chunkId));
  const sourceNames = [...new Set(members.map((item) => item.sourceName))];

  const crossSource = sources.size > 1;

  return {
    kind,
    keys,
    similarity: score,
    crossChunk: chunks.size > 1,
    crossSource,
    rationale: crossSource
      ? `The same requirement appears in ${sourceNames.length} documents: ${sourceNames.join(', ')}. Worth checking whether both authors meant the same thing.`
      : kind === 'exact'
        ? 'These requirements have identical wording.'
        : 'These requirements say nearly the same thing.',
  };
}

/**
 * One disposition for every block, with no gaps.
 *
 * The completeness is the point. Coverage is only a real number if "nothing was
 * recorded about this block" is impossible — otherwise a block the pipeline
 * never reached looks exactly like a block it read and found nothing in, and
 * the difference between those two is the difference between a complete
 * baseline and one with a hole in it.
 */
function assignDispositions(
  input: ReconciliationInput,
  items: readonly ReconciledItem[],
): BlockDispositionRecord[] {
  /*
   * Keyed by source *and* block.
   *
   * Block ids are unique within a source, not across a project: two pasted-text
   * documents both start at `b0`. Keying on the block alone silently collapses
   * one document's dispositions into the other's, and coverage then reports a
   * hole where there is none — or, far worse, no hole where there is one.
   */
  const covering = new Map<string, string[]>();

  for (const item of items) {
    for (const evidence of item.evidence) {
      const key = blockKey(item.sourceId, baseBlockId(evidence.blockId));

      covering.set(key, [...(covering.get(key) ?? []), item.key]);
    }
  }

  const nonRequirement = new Map(
    input.nonRequirementBlocks.map((entry) => [
      blockKey(entry.sourceId, baseBlockId(entry.blockId)),
      entry,
    ]),
  );

  const records: BlockDispositionRecord[] = [];
  const seen = new Set<string>();

  for (const block of input.analysedBlocks) {
    const key = blockKey(block.sourceId, block.blockId);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const itemKeys = covering.get(key) ?? [];
    const judged = nonRequirement.get(key);

    const disposition: BlockDisposition =
      itemKeys.length > 0 ? 'covered' : judged ? 'no_requirement' : 'no_requirement';

    records.push({
      sourceId: block.sourceId,
      blockId: block.blockId,
      chunkId: block.chunkId,
      disposition,
      /*
       * A block that produced nothing and that the model did not explicitly
       * account for still gets a reason — an honest one. Leaving it blank would
       * present an omission as a judgement.
       */
      ...(itemKeys.length > 0
        ? {}
        : {
            reason:
              judged?.reason ??
              'The analysis produced no requirement from this content and gave no reason.',
          }),
      itemIds: itemKeys.slice(0, 50),
    });
  }

  for (const block of input.unanalysedBlocks) {
    const key = blockKey(block.sourceId, block.blockId);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    records.push({
      sourceId: block.sourceId,
      blockId: block.blockId,
      disposition: 'not_analysed',
      reason: 'This part of the document was never analysed.',
      itemIds: [],
    });
  }

  return records;
}

function blockKey(sourceId: string, blockId: string): string {
  return `${sourceId}:${blockId}`;
}

/**
 * Whether two items came from different documents.
 *
 * Small, but it is the predicate that decides whether a conflict is the
 * cross-document kind this phase exists to surface, so it lives where the tests
 * can reach it.
 */
export function isCrossSource(items: readonly { sourceId: string }[]): boolean {
  return new Set(items.map((item) => item.sourceId)).size > 1;
}
