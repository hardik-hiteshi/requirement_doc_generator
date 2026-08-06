import {
  LOW_CONFIDENCE_THRESHOLD,
  type BlockKind,
  type ExtractedBlock,
  type ExtractedContent,
  type ExtractionWarning,
  type SourceReference,
} from '@wdrg/contracts';

/**
 * Accumulates blocks while an extractor reads a file.
 *
 * Every extractor produces the same shape, and every extractor has to enforce
 * the same ceiling on how much it will produce. Doing that once here rather than
 * six times means the limit cannot be right in five formats and forgotten in the
 * sixth — which is exactly how a resource limit fails in practice.
 *
 * Block ids are positional (`b0`, `b1`, …). That makes them stable for a given
 * extraction, which is what a correction addresses, and it makes a re-extraction
 * produce comparable ids. It also means ids are *not* stable across a
 * re-extraction of a changed file — which is correct: the content changed, so
 * corrections against the old content should not silently reattach.
 */
export class BlockBuilder {
  private readonly blocks: ExtractedBlock[] = [];
  private readonly warnings: ExtractionWarning[] = [];
  private truncated = false;

  constructor(private readonly maxBlocks: number) {}

  /**
   * Adds a block, unless the ceiling has been reached.
   *
   * Hitting the limit is recorded once as a warning and then silently ignored —
   * a warning per skipped block would produce a hundred thousand warnings about
   * having too much content.
   */
  add(
    kind: BlockKind,
    text: string,
    reference: SourceReference,
    options: { confidence?: number; viaOcr?: boolean; level?: number } = {},
  ): void {
    if (text.trim().length === 0) {
      return;
    }

    if (this.blocks.length >= this.maxBlocks) {
      if (!this.truncated) {
        this.truncated = true;
        this.warn(
          'TRUNCATED_TEXT',
          `This file contains more than ${this.maxBlocks.toLocaleString()} separate pieces of content. Only the first ${this.maxBlocks.toLocaleString()} were read.`,
        );
      }

      return;
    }

    this.blocks.push({
      id: `b${this.blocks.length}`,
      kind,
      text,
      reference,
      // 1 means "read from a digital text layer": it was not guessed, so there
      // is nothing to be uncertain about. Only OCR supplies anything else.
      confidence: options.confidence ?? 1,
      viaOcr: options.viaOcr ?? false,
      ...(options.level !== undefined ? { level: options.level } : {}),
    });
  }

  warn(code: ExtractionWarning['code'], message: string, reference?: SourceReference): void {
    // One warning per code. Repeating "hidden sheet skipped" for every sheet
    // buries the other warnings, and the user only needs to know it happened.
    if (this.warnings.some((warning) => warning.code === code)) {
      return;
    }

    this.warnings.push({ code, message, ...(reference ? { reference } : {}) });
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  get isFull(): boolean {
    return this.blocks.length >= this.maxBlocks;
  }

  build(
    extractor: string,
    options: { pageCount?: number; sheetNames?: string[] } = {},
  ): ExtractedContent {
    const usedOcr = this.blocks.some((block) => block.viaOcr);
    const minimumConfidence = this.blocks.reduce(
      (lowest, block) => Math.min(lowest, block.confidence),
      1,
    );

    if (usedOcr && minimumConfidence < LOW_CONFIDENCE_THRESHOLD) {
      this.warn(
        'LOW_OCR_CONFIDENCE',
        'Some recognised text is uncertain. Check the highlighted parts and correct anything that is wrong.',
      );
    }

    return {
      blocks: this.blocks,
      warnings: this.warnings,
      // An empty document is not low-confidence, it is empty; reporting 1 keeps
      // "needs review" meaning what it says.
      minimumConfidence: this.blocks.length === 0 ? 1 : minimumConfidence,
      ...(options.pageCount !== undefined ? { pageCount: options.pageCount } : {}),
      ...(options.sheetNames ? { sheetNames: options.sheetNames } : {}),
      usedOcr,
      extractedAt: new Date().toISOString(),
      extractor,
    };
  }
}

/** Normalises line endings and strips characters that break rendering. */
export function normaliseText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- exactly the characters at issue
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      // Zero-width and bidi controls: invisible, and they make text that looks
      // identical compare unequal, which turns a correction into a mystery.
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .trimEnd()
  );
}
