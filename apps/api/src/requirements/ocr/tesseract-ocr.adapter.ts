import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import {
  OcrError,
  type OcrProviderPort,
  type OcrRegion,
  type OcrRequest,
  type OcrResult,
} from '../../ports';

const run = promisify(execFile);

/**
 * OCR through the Tesseract binary.
 *
 * Invoked as a subprocess rather than through a WASM build. The trade-off, in
 * both directions: a native binary is materially faster and more accurate, and a
 * subprocess is isolated — a malformed image crashes a child process, not the
 * API — but it is a prerequisite that must be installed, and a deployment
 * without it gets a clear failure rather than a silent degradation. That is why
 * `isAvailable` exists and is checked at startup.
 *
 * Output is read in TSV, not plain text. Plain text gives words with no
 * confidence and no position, which would make "flag the uncertain parts for
 * review" impossible to implement honestly — the reviewer would have to re-read
 * everything, and would therefore read nothing.
 */
@Injectable()
export class TesseractOcrAdapter implements OcrProviderPort {
  private readonly logger = new Logger(TesseractOcrAdapter.name);
  private available: boolean | undefined;

  constructor(private readonly config: AppConfigService) {}

  async isAvailable(): Promise<boolean> {
    if (!this.config.ocr.enabled) {
      return false;
    }

    if (this.available !== undefined) {
      return this.available;
    }

    try {
      const { stdout } = await run(this.config.ocr.binary, ['--version'], { timeout: 10_000 });
      this.available = true;
      this.logger.log({ version: stdout.split('\n')[0] }, 'OCR engine available');
    } catch (cause) {
      this.available = false;
      this.logger.warn(
        { binary: this.config.ocr.binary, cause },
        'OCR engine not available — image sources will be rejected with a clear message',
      );
    }

    return this.available;
  }

  limitations(): readonly string[] {
    return [
      'Handwriting is not reliably recognised. Typed and printed text is what this engine is good at; handwritten notes will produce low-confidence output that needs correcting by hand.',
      'Text at low resolution, at an angle, or over a busy background recognises poorly.',
      'Layout is approximated. Columns, sidebars and captions may be read in an order that differs from how they appear.',
      'Tables lose their structure. Cells are recognised as text, not as rows and columns.',
    ];
  }

  async recognise(request: OcrRequest): Promise<OcrResult> {
    if (!(await this.isAvailable())) {
      throw new OcrError(
        'engine_unavailable',
        'No OCR engine is configured on this deployment.',
        false,
      );
    }

    const started = Date.now();
    // A temporary directory per call, removed in `finally`. Tesseract wants file
    // paths, and reusing one directory across concurrent calls would let two
    // recognitions overwrite each other's output.
    const workDir = await mkdtemp(join(tmpdir(), 'wdrg-ocr-'));
    const inputPath = join(workDir, `input.${sanitiseExtension(request.format)}`);
    const outputBase = join(workDir, 'output');

    try {
      await writeFile(inputPath, request.content, { mode: 0o600 });

      const args = [
        inputPath,
        outputBase,
        '-l',
        request.languages,
        // Automatic page segmentation *with* orientation and script detection.
        // A scan that arrives sideways is common enough that not correcting it
        // would make the feature useless for exactly the documents that need it.
        '--psm',
        request.detectOrientation ? '1' : '3',
        'tsv',
      ];

      await run(this.config.ocr.binary, args, {
        timeout: this.config.ocr.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });

      const tsv = await readFile(`${outputBase}.tsv`, 'utf8');
      const regions = parseTsv(tsv, request.pageNumber);

      const words = regions.filter((region) => region.text.trim().length > 0);
      const meanConfidence =
        words.length === 0
          ? 0
          : words.reduce((total, region) => total + region.confidence, 0) / words.length;

      return {
        text: assembleText(regions),
        meanConfidence,
        regions: words,
        durationMs: Date.now() - started,
        engine: 'tesseract',
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      if (/timed?\s*out|ETIMEDOUT|SIGTERM/i.test(message)) {
        throw new OcrError('timeout', 'Text recognition took too long and was stopped.', true, {
          cause,
        });
      }

      this.logger.warn({ cause }, 'OCR failed');
      throw new OcrError('engine_error', 'Text recognition failed.', true, { cause });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

/**
 * Tesseract's TSV: one row per detected element, with a `level` column.
 *
 * Level 5 is a word — the only level carrying a real confidence value. The
 * others describe page, block, paragraph and line structure and report -1, so
 * including them would drag the mean towards nonsense.
 */
function parseTsv(tsv: string, pageNumber?: number): OcrRegion[] {
  const lines = tsv.split('\n');
  const header = lines[0]?.split('\t') ?? [];

  const index = {
    level: header.indexOf('level'),
    left: header.indexOf('left'),
    top: header.indexOf('top'),
    width: header.indexOf('width'),
    height: header.indexOf('height'),
    conf: header.indexOf('conf'),
    text: header.indexOf('text'),
    lineNum: header.indexOf('line_num'),
  };

  if (index.level === -1 || index.conf === -1 || index.text === -1) {
    return [];
  }

  const regions: OcrRegion[] = [];

  for (const line of lines.slice(1)) {
    const columns = line.split('\t');

    if (columns.length <= index.text) {
      continue;
    }

    if (columns[index.level] !== '5') {
      continue;
    }

    const text = columns[index.text] ?? '';
    const rawConfidence = Number(columns[index.conf] ?? '-1');

    if (text.trim().length === 0 || rawConfidence < 0) {
      continue;
    }

    regions.push({
      text,
      // Tesseract reports 0–100.
      confidence: Math.max(0, Math.min(1, rawConfidence / 100)),
      boundingBox: {
        x: Number(columns[index.left] ?? '0'),
        y: Number(columns[index.top] ?? '0'),
        width: Math.max(1, Number(columns[index.width] ?? '1')),
        height: Math.max(1, Number(columns[index.height] ?? '1')),
      },
      ...(pageNumber !== undefined ? { pageNumber } : {}),
    });
  }

  return regions;
}

/**
 * Rebuilds readable lines from word boxes.
 *
 * Words are grouped by vertical position rather than by Tesseract's line
 * numbering, which restarts per block and would interleave a two-column layout
 * into gibberish. Grouping by `y` keeps a line a line.
 */
function assembleText(regions: readonly OcrRegion[]): string {
  const lines = new Map<number, OcrRegion[]>();

  for (const region of regions) {
    // Rounded to a coarse band so words on the same visual line, whose boxes
    // differ by a few pixels, land together.
    const band = Math.round((region.boundingBox?.y ?? 0) / 10);
    const existing = lines.get(band);

    if (existing) {
      existing.push(region);
    } else {
      lines.set(band, [region]);
    }
  }

  return [...lines.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, words]) =>
      words
        .sort((a, b) => (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0))
        .map((word) => word.text)
        .join(' '),
    )
    .join('\n')
    .trim();
}

function sanitiseExtension(format: string): string {
  return /^[a-z0-9]{1,5}$/i.test(format) ? format.toLowerCase() : 'png';
}
