/**
 * Outbound boundary for turning an uploaded file into reviewable content.
 *
 * First adapter: Phase 3.
 *
 * Extraction is registry-based: one extractor per format, selected by verified
 * content type. Adding a format is registering an extractor, not editing a
 * switch statement inside the upload service.
 *
 * Every extracted fragment carries its provenance and a confidence score. Both
 * are load-bearing: the requirement baseline cites sources, and low-confidence
 * OCR must be flagged for human review rather than silently treated as fact.
 */

export type ExtractionFormat =
  'pdf' | 'doc' | 'docx' | 'txt' | 'csv' | 'xls' | 'xlsx' | 'png' | 'jpg' | 'jpeg' | 'webp';

/** Where a fragment came from. Fields are populated only where they apply. */
export interface SourceReference {
  readonly sourceId: string;
  readonly filename: string;
  readonly format: ExtractionFormat;
  readonly pageNumber?: number;
  readonly sheetName?: string;
  readonly rowNumber?: number;
  readonly cellRange?: string;
  readonly sectionHeading?: string;
  readonly paragraphIndex?: number;
}

export type FragmentKind = 'heading' | 'paragraph' | 'list_item' | 'table' | 'cell' | 'image_text';

export interface ExtractedFragment {
  readonly kind: FragmentKind;
  readonly text: string;
  readonly reference: SourceReference;
  /** 0–1. Below the review threshold the UI flags the fragment for correction. */
  readonly confidence: number;
  /** True when the text came from OCR rather than an embedded text layer. */
  readonly viaOcr: boolean;
}

export interface ExtractionResult {
  readonly fragments: readonly ExtractedFragment[];
  /** Lowest confidence across all fragments, for a quick "needs review" check. */
  readonly minimumConfidence: number;
  readonly pageCount?: number;
  readonly durationMs: number;
}

export type ExtractionFailureReason =
  | 'unsupported_format'
  | 'corrupted_file'
  | 'password_protected'
  | 'empty_document'
  | 'ocr_failed'
  | 'too_large'
  | 'timeout';

export class FileExtractionError extends Error {
  constructor(
    public readonly reason: ExtractionFailureReason,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FileExtractionError';
  }
}

export interface FileExtractionRequest {
  readonly sourceId: string;
  readonly filename: string;
  readonly format: ExtractionFormat;
  readonly content: Buffer;
  /** Run OCR when the document has no usable text layer. */
  readonly allowOcr: boolean;
}

export interface FileExtractionPort {
  /** Formats this adapter can handle, so callers can reject early and clearly. */
  supports(format: ExtractionFormat): boolean;

  /** @throws {FileExtractionError} for every failure mode above. */
  extract(request: FileExtractionRequest): Promise<ExtractionResult>;
}
