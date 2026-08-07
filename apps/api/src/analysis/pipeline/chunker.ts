import {
  ANALYSIS_LIMITS,
  estimateTokens,
  type AnalysisChunk,
  type ChunkBoundary,
  type ExtractedBlock,
} from '@wdrg/contracts';

/**
 * Splitting a project's reviewed content into pieces a model can actually read.
 *
 * A 7B model with an 8k context cannot hold forty pages of requirements, and
 * pretending otherwise produces the worst possible failure: an answer about the
 * part that fitted, presented as an answer about the whole. So the content is
 * chunked — and chunking is only safe because a later stage reconciles across
 * the chunks.
 *
 * Four rules, each of which exists because breaking it loses something a client
 * would notice.
 *
 * **A chunk never crosses a source.** Two documents in one chunk makes "which
 * file did this come from" a question about the model's attention rather than
 * about the data. Traceability is the one thing that cannot be approximate.
 *
 * **Boundaries follow the document's own structure.** A chunk ends at a heading
 * where it can, because a heading is where the author changed subject. Ending
 * mid-section splits a thought, and the reconciliation stage then has to put
 * back together something that was never meant to be apart.
 *
 * **Nothing is ever silently truncated.** A block bigger than one chunk is split
 * at sentence boundaries into parts that are *all* analysed, and the split is
 * recorded on the chunk. Dropping the tail would report complete coverage over
 * incomplete reading, which is worse than failing.
 *
 * **Every block lands in exactly one chunk.** Coverage is counted in blocks, so
 * a block that appears twice inflates it and a block that appears in none is a
 * silent gap. There is a test for both.
 */

export interface ChunkSource {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly blocks: readonly ExtractedBlock[];
}

export interface ChunkingOptions {
  /** Characters of evidence per chunk, from the model profile's budget. */
  readonly budgetCharacters: number;
  readonly maxChunks: number;
}

export interface ChunkedBlock {
  readonly blockId: string;
  /** The text this chunk carries for the block — the whole block, or one part. */
  readonly text: string;
  /** 0 when the block was not split. */
  readonly partIndex: number;
  readonly partCount: number;
}

export interface ChunkPlan {
  readonly chunks: readonly PlannedChunk[];
  /** Blocks that could not be placed, because the chunk ceiling was reached. */
  readonly unplacedBlockIds: readonly string[];
}

export interface PlannedChunk extends Omit<AnalysisChunk, 'id' | 'runId' | 'status'> {
  /** The text each block contributes, in order. Never stored — passed to the model. */
  readonly contents: readonly ChunkedBlock[];
}

/**
 * Plans the chunks for one run.
 *
 * Pure and synchronous: given the same content and budget it produces the same
 * plan, which is what makes a chunk id stable enough to cite in an audit record.
 */
export function planChunks(sources: readonly ChunkSource[], options: ChunkingOptions): ChunkPlan {
  const budget = clampBudget(options.budgetCharacters);
  const chunks: PlannedChunk[] = [];
  const unplaced: string[] = [];

  for (const source of sources) {
    const blocks = source.blocks.filter((block) => block.text.trim().length > 0);

    if (blocks.length === 0) {
      continue;
    }

    let current: WorkingChunk = start(source, blocks[0]);

    for (const block of blocks) {
      const pieces = splitBlock(block, budget);

      for (const piece of pieces) {
        const wouldExceed = current.characterCount + piece.text.length > budget;
        const atHeading = block.kind === 'heading' && current.contents.length > 0;

        if (current.contents.length > 0 && (wouldExceed || atHeading)) {
          chunks.push(seal(current, source, chunks.length, atHeading && !wouldExceed));
          current = start(source, block);
        }

        current.contents.push(piece);
        current.characterCount += piece.text.length;

        if (!current.blockIds.includes(piece.blockId)) {
          current.blockIds.push(piece.blockId);
        }

        if (piece.partCount > 1) {
          const existing = current.blockParts.find((part) => part.blockId === piece.blockId);

          if (existing) {
            existing.parts = piece.partCount;
          } else {
            current.blockParts.push({ blockId: piece.blockId, parts: piece.partCount });
          }
        }
      }
    }

    if (current.contents.length > 0) {
      // The last chunk of a source ends because the source ended, which is the
      // cleanest boundary there is.
      chunks.push(seal(current, source, chunks.length, false, 'source_end'));
    }
  }

  /*
   * The ceiling is a refusal, not a truncation. Everything beyond it is
   * reported as unplaced, becomes a `not_analysed` disposition, and blocks
   * approval — so a project too large to analyse says so rather than producing
   * a confident baseline built from its first two hundred chunks.
   */
  if (chunks.length > options.maxChunks) {
    const kept = chunks.slice(0, options.maxChunks);
    const dropped = chunks.slice(options.maxChunks);

    return {
      chunks: kept.map((chunk, index) => ({ ...chunk, index })),
      unplacedBlockIds: dropped.flatMap((chunk) => chunk.blockIds).concat(unplaced),
    };
  }

  return { chunks, unplacedBlockIds: unplaced };
}

interface WorkingChunk {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly contents: ChunkedBlock[];
  readonly blockIds: string[];
  readonly blockParts: { blockId: string; parts: number }[];
  characterCount: number;
  readonly heading: string | undefined;
}

function start(source: ChunkSource, block: ExtractedBlock | undefined): WorkingChunk {
  return {
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    contents: [],
    blockIds: [],
    blockParts: [],
    characterCount: 0,
    heading: block?.kind === 'heading' ? block.text.trim().slice(0, 500) : block?.reference.heading,
  };
}

function seal(
  working: WorkingChunk,
  source: ChunkSource,
  index: number,
  endedAtHeading: boolean,
  override?: ChunkBoundary,
): PlannedChunk {
  const boundary: ChunkBoundary =
    override ??
    (endedAtHeading ? 'heading' : working.blockParts.length > 0 ? 'block_split' : 'size_limit');

  return {
    index,
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    blockIds: [...working.blockIds],
    blockParts: working.blockParts.map((part) => ({ ...part })),
    characterCount: working.characterCount,
    estimatedTokens: estimateTokens(working.contents.map((piece) => piece.text).join('\n')),
    boundary,
    ...(working.heading ? { heading: working.heading } : {}),
    contents: [...working.contents],
  };
}

/**
 * One block as one or more pieces, each within the budget.
 *
 * Split at sentence ends where possible, then at whitespace, and only in the
 * middle of a word when a single "sentence" is longer than a whole chunk — a
 * pathological case (a wall of text with no punctuation) that still has to
 * produce something rather than looping.
 */
function splitBlock(block: ExtractedBlock, budget: number): ChunkedBlock[] {
  const text = block.text;

  if (text.length <= budget) {
    return [{ blockId: block.id, text, partIndex: 0, partCount: 1 }];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > budget) {
    const window = remaining.slice(0, budget);
    const cut = lastSentenceEnd(window) ?? lastWhitespace(window) ?? budget;

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts.map((part, partIndex) => ({
    blockId: block.id,
    text: part,
    partIndex,
    partCount: parts.length,
  }));
}

function lastSentenceEnd(window: string): number | null {
  const match = /[.!?]["')\]]?\s(?=[^\s])/g;
  let last: number | null = null;
  let found: RegExpExecArray | null;

  while ((found = match.exec(window)) !== null) {
    last = found.index + found[0].length;
  }

  // Only useful if it leaves a substantial piece; a cut at character 12 of a
  // 12,000-character budget would produce hundreds of tiny chunks.
  return last !== null && last > window.length * 0.5 ? last : null;
}

function lastWhitespace(window: string): number | null {
  const index = window.lastIndexOf(' ');

  return index > window.length * 0.5 ? index : null;
}

function clampBudget(budget: number): number {
  return Math.max(
    ANALYSIS_LIMITS.minChunkCharacters,
    Math.min(ANALYSIS_LIMITS.maxChunkCharacters, budget),
  );
}

/** The evidence a chunk carries, in the shape the task runner wants. */
export function chunkEvidence(chunk: PlannedChunk): { blockId: string; text: string }[] {
  return chunk.contents.map((piece) => ({
    // A split block's parts are cited individually so the model can quote the
    // part it read, and the application maps the citation back to the block.
    blockId: piece.partCount > 1 ? `${piece.blockId}#${piece.partIndex}` : piece.blockId,
    text: piece.text,
  }));
}

/** Strips the part suffix a split block's evidence id carries. */
export function baseBlockId(citedId: string): string {
  const hash = citedId.indexOf('#');

  return hash === -1 ? citedId : citedId.slice(0, hash);
}
