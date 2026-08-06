import { Injectable, Logger } from '@nestjs/common';
import type { ExtractedContent } from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import {
  FileExtractionError,
  type ExtractionFormat,
  type FileExtractionPort,
  type FileExtractionRequest,
  type ExtractionResult,
} from '../../ports';
import type { ExtractorContext, FormatExtractor } from './extractor.types';
import { ImageExtractor } from './image-extractor';
import { DocxExtractor, XlsxExtractor } from './office-extractors';
import { PdfExtractor } from './pdf-extractor';
import { CsvExtractor, TxtExtractor } from './text-extractors';

/**
 * The extractor registry, and the timeout that bounds all of them.
 *
 * Format dispatch is a map built at construction, so adding a format is adding a
 * class to the constructor rather than editing a switch. The registry is built
 * from each extractor's own `formats` list, which means an extractor cannot be
 * registered for a format it does not declare it handles.
 *
 * The timeout lives here rather than inside each extractor for the same reason
 * the block limit lives in the builder: six implementations of the same guard is
 * five chances to get it wrong. A parser handed a hostile file can loop or
 * allocate without bound, and the only reliable defence is a wall-clock ceiling
 * outside it.
 */
@Injectable()
export class ExtractionService implements FileExtractionPort {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly registry = new Map<string, FormatExtractor>();

  constructor(
    private readonly config: AppConfigService,
    txt: TxtExtractor,
    csv: CsvExtractor,
    docx: DocxExtractor,
    xlsx: XlsxExtractor,
    pdf: PdfExtractor,
    image: ImageExtractor,
  ) {
    for (const extractor of [txt, csv, docx, xlsx, pdf, image]) {
      for (const format of extractor.formats) {
        this.registry.set(format, extractor);
      }
    }
  }

  supports(format: ExtractionFormat): boolean {
    return this.registry.has(format);
  }

  /** The `FileExtractionPort` shape. Most callers want `extractContent`. */
  async extract(request: FileExtractionRequest): Promise<ExtractionResult> {
    const started = Date.now();
    const content = await this.extractContent({
      sourceId: request.sourceId,
      filename: request.filename,
      content: request.content,
      allowOcr: request.allowOcr,
    });

    return {
      fragments: content.blocks.map((block) => ({
        kind: block.kind === 'table_row' ? 'table' : block.kind,
        text: block.text,
        reference: {
          sourceId: request.sourceId,
          filename: request.filename,
          format: request.format,
          ...block.reference,
        },
        confidence: block.confidence,
        viaOcr: block.viaOcr,
      })),
      minimumConfidence: content.minimumConfidence,
      ...(content.pageCount !== undefined ? { pageCount: content.pageCount } : {}),
      durationMs: Date.now() - started,
    };
  }

  /** Runs the right extractor, under the configured timeout. */
  async extractContent(context: ExtractorContext): Promise<ExtractedContent> {
    const format = formatOf(context.filename);
    const extractor = this.registry.get(format);

    if (!extractor) {
      throw new FileExtractionError(
        'unsupported_format',
        `No extractor is registered for .${format} files.`,
        false,
      );
    }

    return withTimeout(extractor.extract(context), this.config.extraction.timeoutMs, () => {
      this.logger.warn(
        { sourceId: context.sourceId, format },
        'Extraction exceeded its time limit',
      );

      return new FileExtractionError(
        'timeout',
        'Reading this file took too long and was stopped.',
        // Retryable: a timeout can be transient load rather than a hostile
        // file, and the attempt limit stops a genuinely unreadable file from
        // retrying forever.
        true,
      );
    });
  }

  /** Which formats this deployment can read. Drives the UI's accept list. */
  supportedFormats(): string[] {
    return [...this.registry.keys()];
  }
}

function formatOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index + 1).toLowerCase();
}

/**
 * Races work against a timer.
 *
 * The losing promise is not cancelled — JavaScript has no way to do that — so a
 * timed-out extraction keeps running until it finishes or the process exits.
 * That is a real limitation and worth naming: the timeout bounds how long a
 * *user* waits and how long a job holds its claim, not how long the CPU works.
 * Bounding the latter would mean a worker process per extraction, which is the
 * right answer at a scale this application is not at.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
