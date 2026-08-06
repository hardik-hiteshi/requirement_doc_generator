import { Inject, Injectable } from '@nestjs/common';
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
 * Images: PNG, JPG, JPEG, WEBP.
 *
 * An image has no text layer, so OCR is not a fallback here — it is the whole
 * extractor. That changes what the output means. Every block is a guess with a
 * confidence attached, and the honest thing to do with a guess is to say so:
 * blocks are marked `viaOcr`, low-confidence ones are flagged, and the source
 * lands in `REVIEW_REQUIRED` rather than `READY`.
 *
 * Where the engine reports word positions, they are kept. That is what lets the
 * review UI point at *which* words are uncertain instead of asking someone to
 * re-read a page they cannot check against anything.
 */
@Injectable()
export class ImageExtractor implements FormatExtractor {
  readonly id = 'image-ocr';
  readonly formats = ['png', 'jpg', 'jpeg', 'webp'] as const;

  constructor(
    private readonly config: AppConfigService,
    @Inject(OCR_PROVIDER_PORT) private readonly ocr: OcrProviderPort,
  ) {}

  async extract(context: ExtractorContext): Promise<ExtractedContent> {
    const builder = new BlockBuilder(this.config.extraction.maxBlocks);

    if (!context.allowOcr || !(await this.ocr.isAvailable())) {
      throw new FileExtractionError(
        'ocr_failed',
        'Text recognition is not available on this deployment, so images cannot be read.',
        // Not retryable: retrying will not install an OCR engine.
        false,
      );
    }

    await context.onProgress?.(20, 'Recognising text');

    let result;

    try {
      result = await this.ocr.recognise({
        content: context.content,
        format: extensionOf(context.filename),
        languages: this.config.ocr.languages,
        detectOrientation: true,
      });
    } catch (cause) {
      if (cause instanceof OcrError) {
        throw new FileExtractionError(
          cause.reason === 'timeout' ? 'timeout' : 'ocr_failed',
          cause.reason === 'timeout'
            ? 'Text recognition took too long and was stopped.'
            : 'Text recognition failed for this image.',
          cause.retryable,
          { cause },
        );
      }

      throw cause;
    }

    await context.onProgress?.(80, 'Organising recognised text');

    if (result.regions.length === 0) {
      throw new FileExtractionError(
        'empty_document',
        'No text could be recognised in this image.',
        false,
      );
    }

    // Grouped into lines rather than emitted per word. A block per word would be
    // technically more precise and completely unreviewable — nobody corrects a
    // thousand one-word rows.
    for (const line of groupIntoLines(result.regions)) {
      builder.add(
        'image_text',
        normaliseText(line.text),
        { region: line.boundingBox },
        { confidence: line.confidence, viaOcr: true },
      );
    }

    if (result.meanConfidence < this.config.ocr.minConfidence) {
      builder.warn(
        'LOW_OCR_CONFIDENCE',
        `Overall recognition confidence for this image is ${Math.round(result.meanConfidence * 100)}%. Read it through and correct anything wrong before continuing.`,
      );
    }

    // Stated on every image, not only on poor ones. A user who uploads a
    // photographed whiteboard needs to know before they trust the output, and
    // the confidence score alone does not tell them handwriting is the problem.
    builder.warn(
      'HANDWRITING_UNRELIABLE',
      'Handwriting is not reliably recognised. Typed and printed text is what this engine reads well.',
    );

    return builder.build(`image-ocr:${result.engine}`);
  }
}

interface OcrLine {
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: { x: number; y: number; width: number; height: number };
}

/**
 * Groups word boxes into lines.
 *
 * A line's confidence is its *lowest* word, not its mean. Averaging hides the
 * one word that was guessed — which is precisely the word a reviewer needs to
 * look at — and a line is only as trustworthy as its least certain part.
 */
export function groupIntoLines(
  regions: readonly {
    text: string;
    confidence: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
  }[],
): OcrLine[] {
  const bands = new Map<number, (typeof regions)[number][]>();

  for (const region of regions) {
    const band = Math.round((region.boundingBox?.y ?? 0) / 12);
    const existing = bands.get(band);

    if (existing) {
      existing.push(region);
    } else {
      bands.set(band, [region]);
    }
  }

  return [...bands.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, words]) => {
      const ordered = [...words].sort((a, b) => (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0));

      const boxes = ordered.map((word) => word.boundingBox).filter(Boolean) as {
        x: number;
        y: number;
        width: number;
        height: number;
      }[];

      const x = boxes.length > 0 ? Math.min(...boxes.map((box) => box.x)) : 0;
      const y = boxes.length > 0 ? Math.min(...boxes.map((box) => box.y)) : 0;
      const right = boxes.length > 0 ? Math.max(...boxes.map((box) => box.x + box.width)) : 1;
      const bottom = boxes.length > 0 ? Math.max(...boxes.map((box) => box.y + box.height)) : 1;

      return {
        text: ordered.map((word) => word.text).join(' '),
        confidence: ordered.reduce((lowest, word) => Math.min(lowest, word.confidence), 1),
        boundingBox: {
          x,
          y,
          width: Math.max(1, right - x),
          height: Math.max(1, bottom - y),
        },
      };
    })
    .filter((line) => line.text.trim().length > 0);
}

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index === -1 ? 'png' : filename.slice(index + 1).toLowerCase();
}
