import type { ExtractedContent } from '@wdrg/contracts';

/**
 * What one format's extractor is handed.
 *
 * The buffer, the filename for citations, and whether OCR may run. That last
 * flag is not a performance switch: OCR is the only path by which a file's
 * *pixels* become text a later phase will treat as a requirement, and a
 * deployment with no engine must fail clearly rather than return an empty
 * document that looks like a blank file.
 */
export interface ExtractorContext {
  readonly sourceId: string;
  readonly filename: string;
  readonly content: Buffer;
  readonly allowOcr: boolean;
  /** Checked between units of work so a cancelled job stops promptly. */
  readonly isCancelled?: () => Promise<boolean>;
  /** Reports progress for long documents, so the UI is not a frozen spinner. */
  readonly onProgress?: (percent: number, label: string) => Promise<void>;
}

/**
 * One format, one extractor.
 *
 * A registry rather than a switch statement: adding a format is registering a
 * class, and no existing file has to be edited to do it — which is what stops
 * the upload service slowly accumulating knowledge of every format's quirks.
 */
export interface FormatExtractor {
  /** Recorded on the output, so content can be attributed to what produced it. */
  readonly id: string;
  readonly formats: readonly string[];
  extract(context: ExtractorContext): Promise<ExtractedContent>;
}
