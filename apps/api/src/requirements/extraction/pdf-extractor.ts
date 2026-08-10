import { dirname, join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ExtractedContent } from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import {
  FileExtractionError,
  OcrError,
  OCR_PROVIDER_PORT,
  type OcrProviderPort,
} from '../../ports';
import { BlockBuilder, normaliseText } from './block-builder';
import type { ExtractorContext, FormatExtractor } from './extractor.types';

/**
 * ESM loaded from a CommonJS build.
 *
 * pdfjs ships ESM only, and this application compiles to CommonJS, where a
 * literal `import()` is rewritten to `require()` by the transpiler and fails on
 * an ESM module. Building the import through `Function` puts the specifier
 * beyond the compiler's reach, so what runs is a genuine dynamic import.
 *
 * The alternative — a CommonJS PDF library — means an unmaintained package or
 * one that gives a single text blob with no page numbers, and page numbers are
 * the entire reason this extractor exists.
 */
const importEsm =
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- a genuine dynamic import the transpiler must not rewrite, not evaluated code
  new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;

const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * How many times this process has had to reload pdfjs.
 *
 * The module lives in Node's own ESM registry, which is **process-level** and
 * outside any module isolation a test framework provides. That is harmless in
 * production, where one process serves one application for its lifetime. It is
 * not harmless in a process that builds an application and tears it down again:
 * pdfjs is left holding state that has been disposed, and the next document
 * fails with an internal error about a property of `undefined` — which looks
 * exactly like a corrupt file and is not.
 *
 * Appending a query string makes the specifier distinct, so Node loads a fresh
 * copy. The counter advances only on a real failure, so the ordinary path pays
 * nothing for this.
 */
let pdfjsGeneration = 0;

function loadPdfjs(): Promise<Record<string, unknown>> {
  return importEsm(
    pdfjsGeneration === 0 ? PDFJS_SPECIFIER : `${PDFJS_SPECIFIER}?generation=${pdfjsGeneration}`,
  );
}

/**
 * Whether a failure is a disposed pdfjs rather than a bad PDF.
 *
 * Deliberately narrow. A corrupt file must still be reported as a corrupt file:
 * reloading the library and retrying on every failure would turn one honest
 * rejection into two slow ones.
 */
function isDisposedModuleFailure(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);

  return /Cannot read properties of undefined \(reading '(identifier|workerPort|_capability)'\)/.test(
    message,
  );
}

/** The one canvas function this needs, so the native binding stays lazy. */
type CreateCanvas = (
  width: number,
  height: number,
) => {
  readonly width: number;
  readonly height: number;
  getContext(kind: '2d'): {
    fillStyle: string;
    fillRect(x: number, y: number, w: number, h: number): void;
  };
  toBuffer(mime: 'image/png'): Buffer;
};

/** Minimal shape of what this uses. pdfjs's own types are ESM-only. */
interface PdfTextItem {
  readonly str?: string;
  readonly transform?: readonly number[];
}

interface PdfViewport {
  readonly width: number;
  readonly height: number;
}

interface PdfPage {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: Record<string, unknown>): { promise: Promise<void> };
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/** `destroy` lives on the loading task, not on the document it resolves to. */
interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/**
 * PDF.
 *
 * Two kinds of PDF arrive, and they need opposite handling. A digitally
 * generated one has a text layer, which is exact and fast to read. A scan is a
 * picture of a document with no text at all, and reading it means OCR — slower,
 * approximate, and requiring review.
 *
 * The difference is detected per page rather than per document, because mixed
 * files are ordinary: a contract typed in Word with a signed page photographed
 * and appended. Deciding once for the whole file would either skip OCR on the
 * page that needed it, or run OCR over pages whose text was already perfect and
 * degrade them.
 *
 * Every block carries its page number. That is what a requirement baseline cites
 * back to, and it is why the text layer is read page by page rather than in one
 * pass.
 */
@Injectable()
export class PdfExtractor implements FormatExtractor {
  readonly id = 'pdf';
  readonly formats = ['pdf'] as const;
  private readonly logger = new Logger(PdfExtractor.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(OCR_PROVIDER_PORT) private readonly ocr: OcrProviderPort,
  ) {}

  async extract(context: ExtractorContext): Promise<ExtractedContent> {
    const builder = new BlockBuilder(this.config.extraction.maxBlocks);

    const openOptions = (): unknown => ({
      // A copy: pdfjs transfers ownership of the buffer it is given and
      // detaches it, which would corrupt the caller's content on retry.
      data: new Uint8Array(context.content),
      // No network, ever. A PDF that references an external font or an XFA
      // form must not become an outbound request from the server.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Resolved on disk from the installed package. Left unset, pdfjs warns
      // on every document and falls back to approximate metrics, which shifts
      // the text positions this extractor groups lines by.
      standardFontDataUrl: standardFontsDirectory(),
    });

    const open = async (): Promise<{ task: PdfLoadingTask; document: PdfDocument }> => {
      const pdfjs = await loadPdfjs();
      const getDocument = pdfjs.getDocument as (options: unknown) => PdfLoadingTask;
      const loading = getDocument(openOptions());

      return { task: loading, document: await loading.promise };
    };

    let task: PdfLoadingTask;
    let document: PdfDocument;

    try {
      ({ task, document } = await open());
    } catch (cause) {
      /*
       * One retry, and only for a disposed library. This is our own process
       * state, not the user's file, and reporting it as a corrupt PDF would
       * blame them for it.
       */
      if (!isDisposedModuleFailure(cause)) {
        const message = cause instanceof Error ? cause.message : String(cause);

        if (
          /password/i.test(message) ||
          (cause as { name?: string })?.name === 'PasswordException'
        ) {
          throw new FileExtractionError(
            'password_protected',
            'This PDF is password-protected.',
            false,
            { cause },
          );
        }

        this.logger.warn({ cause, sourceId: context.sourceId }, 'PDF could not be opened');
        throw new FileExtractionError('corrupted_file', 'This PDF could not be opened.', false, {
          cause,
        });
      }

      this.logger.warn(
        { sourceId: context.sourceId },
        'Reloaded the PDF library after a disposed-module failure',
      );

      pdfjsGeneration += 1;
      ({ task, document } = await open());
    }

    try {
      const pageCount = Math.min(document.numPages, this.config.extraction.maxPages);

      if (document.numPages > this.config.extraction.maxPages) {
        builder.warn(
          'TRUNCATED_TEXT',
          `This PDF has ${document.numPages} pages. The first ${pageCount} were read.`,
        );
      }

      let imageOnlyPages = 0;

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (await context.isCancelled?.()) {
          break;
        }

        await context.onProgress?.(
          Math.round((pageNumber / pageCount) * 100),
          `Reading page ${pageNumber} of ${pageCount}`,
        );

        const page = await document.getPage(pageNumber);
        const lines = await readTextLayer(page);

        if (lines.length > 0) {
          for (const line of lines) {
            builder.add('paragraph', normaliseText(line), { pageNumber });
          }

          continue;
        }

        // No text layer. Either the page is genuinely blank, or it is a scan.
        imageOnlyPages += 1;

        if (!context.allowOcr) {
          continue;
        }

        await this.ocrPage(builder, page, pageNumber);
      }

      if (imageOnlyPages > 0) {
        builder.warn(
          'IMAGE_ONLY_PAGES',
          context.allowOcr
            ? `${imageOnlyPages} page(s) contained no text layer and were read by text recognition. Check them carefully.`
            : `${imageOnlyPages} page(s) contained no text layer and could not be read, because text recognition is not available.`,
        );
      }

      if (builder.blockCount === 0) {
        throw new FileExtractionError(
          'empty_document',
          imageOnlyPages > 0
            ? 'This PDF appears to be a scan, and no text could be recognised from it.'
            : 'This PDF contains no readable text.',
          false,
        );
      }

      return builder.build('pdf', { pageCount: document.numPages });
    } finally {
      await task.destroy().catch(() => undefined);
    }
  }

  /** Rasterises one page and runs OCR over the image. */
  private async ocrPage(builder: BlockBuilder, page: PdfPage, pageNumber: number): Promise<void> {
    if (!(await this.ocr.isAvailable())) {
      builder.warn(
        'IMAGE_ONLY_PAGES',
        'Text recognition is not available on this deployment, so scanned pages could not be read.',
        { pageNumber },
      );
      return;
    }

    try {
      const rendered = await renderPageToPng(page);

      const result = await this.ocr.recognise({
        content: rendered,
        format: 'png',
        languages: this.config.ocr.languages,
        detectOrientation: true,
        pageNumber,
      });

      for (const region of result.regions) {
        builder.add(
          'image_text',
          normaliseText(region.text),
          {
            pageNumber,
            ...(region.boundingBox ? { region: region.boundingBox } : {}),
          },
          { confidence: region.confidence, viaOcr: true },
        );
      }
    } catch (cause) {
      if (cause instanceof OcrError) {
        builder.warn(
          'PARTIAL_EXTRACTION',
          `Text recognition failed for page ${pageNumber}. The rest of the document was read.`,
          { pageNumber },
        );
        return;
      }

      this.logger.warn({ cause, pageNumber }, 'Page rasterisation failed');
      builder.warn(
        'PARTIAL_EXTRACTION',
        `Page ${pageNumber} could not be prepared for text recognition. The rest of the document was read.`,
        { pageNumber },
      );
    }
  }
}

/**
 * Where pdfjs's bundled standard fonts live on disk.
 *
 * Resolved from the installed package rather than hard-coded, so it follows
 * pnpm's content-addressed layout instead of assuming a flat `node_modules`.
 */
function standardFontsDirectory(): string {
  const packageJson = require.resolve('pdfjs-dist/package.json');

  return `${join(dirname(packageJson), 'standard_fonts')}/`;
}

/**
 * Rasterises a page to PNG for OCR.
 *
 * Scale 2 is not arbitrary. Tesseract's accuracy is a function of how many
 * pixels a character occupies, and a PDF page rendered at its nominal 72 dpi
 * gives roughly 10-pixel glyphs, which recognises badly. Doubling puts it near
 * 150 dpi — enough for reliable recognition without producing an image so large
 * that recognition becomes the slow part of the pipeline.
 */
async function renderPageToPng(page: PdfPage): Promise<Buffer> {
  // Required lazily: the native binding is only needed for scanned PDFs, and an
  // API that never receives one should not load it at startup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native binding
  const { createCanvas } = require('@napi-rs/canvas') as { createCanvas: CreateCanvas };

  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext('2d');

  // White first. A PDF page has no background of its own, and rendering onto
  // transparency gives OCR black text on black.
  canvasContext.fillStyle = '#ffffff';
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext, viewport, canvas }).promise;

  return canvas.toBuffer('image/png');
}

/**
 * Groups a page's text items into lines.
 *
 * pdfjs emits positioned fragments, not lines — a justified paragraph can arrive
 * as one item per word. Joining them all with spaces produces a wall of text
 * with no structure; grouping by the `y` component of each item's transform
 * reconstructs the lines a reader sees.
 */
async function readTextLayer(page: PdfPage): Promise<string[]> {
  const content = await page.getTextContent();
  const rows = new Map<number, { x: number; text: string }[]>();

  for (const raw of content.items) {
    const item = raw as PdfTextItem;
    const text = item.str ?? '';

    if (text.trim().length === 0) {
      continue;
    }

    const transform = item.transform ?? [];
    const x = Number(transform[4] ?? 0);
    const y = Number(transform[5] ?? 0);
    // Rounded into bands so fragments on one visual line group together despite
    // sub-pixel differences.
    const band = Math.round(y);

    const existing = rows.get(band);

    if (existing) {
      existing.push({ x, text });
    } else {
      rows.set(band, [{ x, text }]);
    }
  }

  return (
    [...rows.entries()]
      // PDF's origin is bottom-left, so descending y is top-to-bottom reading order.
      .sort(([a], [b]) => b - a)
      .map(([, items]) =>
        items
          .sort((a, b) => a.x - b.x)
          .map((item) => item.text)
          .join('')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((line) => line.length > 0)
  );
}
