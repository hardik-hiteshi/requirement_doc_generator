import { z } from 'zod';

/**
 * The shape extraction produces, whatever it read.
 *
 * A single blob of text would be simpler and would also throw away the thing
 * later phases need most: **where each sentence came from**. A requirement
 * baseline that cannot cite "page 4" or "Sheet2!B12" is not auditable, and a
 * client cannot check it.
 *
 * So every extractor normalises into the same block list, and every block
 * carries a reference populated only with what that format genuinely knows. A
 * CSV has rows and no pages; a PDF has pages and no sheets. Nothing invents a
 * coordinate it does not have — see `sourceReferenceSchema`.
 */

export const BLOCK_KINDS = [
  'heading',
  'paragraph',
  'list_item',
  'table',
  'table_row',
  'cell',
  'image_text',
] as const;

export const blockKindSchema = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof blockKindSchema>;

/**
 * Where a block came from.
 *
 * Every field is optional because every field is format-specific, and an absent
 * reference is information: it says the extractor could not locate this content
 * more precisely, which is different from locating it at page 1.
 */
export const sourceReferenceSchema = z
  .object({
    /** 1-based, as a reader would count. */
    pageNumber: z.number().int().positive().optional(),
    sheetName: z.string().min(1).max(200).optional(),
    /** 1-based row, matching the spreadsheet's own numbering. */
    rowNumber: z.number().int().positive().optional(),
    /** A1-notation range, e.g. `B2` or `B2:D5`. */
    cellRange: z.string().min(1).max(64).optional(),
    /** 1-based line, for text files. */
    lineNumber: z.number().int().positive().optional(),
    /** The nearest enclosing heading, for documents that have them. */
    heading: z.string().max(500).optional(),
    /** 0-based index within the document body. */
    paragraphIndex: z.number().int().nonnegative().optional(),
    /** OCR bounding box, in pixels, when the engine reports one. */
    region: z
      .object({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .optional(),
    /** Which revision of a pasted-text source this came from. */
    textVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SourceReference = z.infer<typeof sourceReferenceSchema>;

/** True when the reference locates the content, rather than merely existing. */
export function hasLocation(reference: SourceReference): boolean {
  return (
    reference.pageNumber !== undefined ||
    reference.rowNumber !== undefined ||
    reference.lineNumber !== undefined ||
    reference.cellRange !== undefined ||
    reference.paragraphIndex !== undefined
  );
}

/** A human-readable citation, or `undefined` when there is nothing to cite. */
export function describeReference(reference: SourceReference): string | undefined {
  const parts: string[] = [];

  if (reference.pageNumber !== undefined) {
    parts.push(`Page ${reference.pageNumber}`);
  }

  if (reference.sheetName !== undefined) {
    parts.push(
      reference.cellRange ? `${reference.sheetName}!${reference.cellRange}` : reference.sheetName,
    );
  } else if (reference.cellRange !== undefined) {
    parts.push(reference.cellRange);
  }

  if (reference.rowNumber !== undefined && reference.cellRange === undefined) {
    parts.push(`Row ${reference.rowNumber}`);
  }

  if (reference.lineNumber !== undefined) {
    parts.push(`Line ${reference.lineNumber}`);
  }

  if (parts.length === 0 && reference.heading !== undefined) {
    parts.push(reference.heading);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export const extractedBlockSchema = z
  .object({
    /** Stable within a source, so a correction can address one block. */
    id: z.string().min(1).max(64),
    kind: blockKindSchema,
    text: z.string(),
    reference: sourceReferenceSchema,
    /**
     * 0–1. Text read from a digital layer is 1: it was not guessed. Only OCR
     * produces anything lower, and a low value is a signal to a human, not a
     * number to average away.
     */
    confidence: z.number().min(0).max(1),
    viaOcr: z.boolean(),
    /** Nesting depth for headings and list items. */
    level: z.number().int().nonnegative().max(10).optional(),
  })
  .strict();

export type ExtractedBlock = z.infer<typeof extractedBlockSchema>;

export const EXTRACTION_WARNING_CODES = [
  'IMAGE_ONLY_PAGES',
  'LOW_OCR_CONFIDENCE',
  'TABLE_STRUCTURE_UNCERTAIN',
  'HIDDEN_SHEET_SKIPPED',
  'MERGED_CELLS_FLATTENED',
  'TRUNCATED_ROWS',
  'TRUNCATED_TEXT',
  'ENCODING_GUESSED',
  'FORMULA_NOT_EVALUATED',
  'PARTIAL_EXTRACTION',
  'HANDWRITING_UNRELIABLE',
] as const;

export const extractionWarningSchema = z
  .object({
    code: z.enum(EXTRACTION_WARNING_CODES),
    /** Plain language, safe to show. Never a stack trace or a library message. */
    message: z.string().min(1).max(500),
    reference: sourceReferenceSchema.optional(),
  })
  .strict();

export type ExtractionWarning = z.infer<typeof extractionWarningSchema>;

export const extractedContentSchema = z
  .object({
    blocks: z.array(extractedBlockSchema),
    warnings: z.array(extractionWarningSchema),
    /** Lowest confidence across all blocks — the quick "needs review" check. */
    minimumConfidence: z.number().min(0).max(1),
    pageCount: z.number().int().nonnegative().optional(),
    sheetNames: z.array(z.string()).optional(),
    /** True when any block was produced by OCR. */
    usedOcr: z.boolean(),
    extractedAt: z.iso.datetime(),
    /** Which extractor produced this, so output can be attributed. */
    extractor: z.string().min(1).max(100),
  })
  .strict();

export type ExtractedContent = z.infer<typeof extractedContentSchema>;

/**
 * Below this, a block is flagged for human review.
 *
 * Tesseract's per-word confidence is not a probability of correctness, so this
 * is a pragmatic threshold rather than a statistical one: it is set where the
 * output stops being reliably readable, and it is deliberately generous. The
 * cost of over-flagging is a glance; the cost of under-flagging is a wrong
 * requirement in a signed document.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

export function isLowConfidence(block: ExtractedBlock): boolean {
  return block.confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function countLowConfidenceBlocks(content: ExtractedContent): number {
  return content.blocks.filter(isLowConfidence).length;
}

/** Blocks joined into readable text. Presentation only — never storage. */
export function blocksToPlainText(blocks: readonly ExtractedBlock[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}
