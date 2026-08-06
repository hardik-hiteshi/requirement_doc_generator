import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { FileExtractionError } from '../../ports';
import { BlockBuilder, normaliseText } from './block-builder';
import type { ExtractorContext, FormatExtractor } from './extractor.types';

/**
 * Plain text.
 *
 * Line numbers are the whole point. A requirement quoted from a text file is
 * only checkable if the reader can find the line it came from, so every
 * non-empty line becomes a block carrying its own 1-based number — matching what
 * an editor shows, not a zero-based index only a programmer would recognise.
 */
@Injectable()
export class TxtExtractor implements FormatExtractor {
  readonly id = 'txt';
  readonly formats = ['txt'] as const;

  constructor(private readonly config: AppConfigService) {}

  /*
   * `async` so a refusal rejects the returned promise. A synchronous throw from
   * a method the interface declares as returning a Promise makes every caller
   * need both a try/catch and a .catch to be safe.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async extract(context: ExtractorContext): Promise<ReturnType<BlockBuilder['build']>> {
    const builder = new BlockBuilder(this.config.extraction.maxBlocks);
    const { text, guessed } = decodeText(context.content);

    if (guessed) {
      builder.warn(
        'ENCODING_GUESSED',
        'This file does not declare its character encoding, so one was inferred. Check any unusual characters.',
      );
    }

    const lines = normaliseText(text).split('\n');

    lines.forEach((line, index) => {
      builder.add('paragraph', line.trim(), { lineNumber: index + 1 });
    });

    if (builder.blockCount === 0) {
      throw new FileExtractionError('empty_document', 'The file contains no readable text.', false);
    }

    return builder.build('txt');
  }
}

/**
 * CSV.
 *
 * Two things matter here and neither is parsing speed.
 *
 * **Formulas are never evaluated.** A cell beginning `=`, `+`, `-` or `@` is
 * kept exactly as written and marked as formula text. Evaluating it would be a
 * code-execution path from an uploaded file; stripping it would silently alter a
 * client's requirements. Neither is acceptable, so it is quoted verbatim and
 * flagged.
 *
 * **Every value keeps its row.** A requirement in a spreadsheet is cited as
 * "row 14", so rows are 1-based and include the header row, exactly as the
 * user's own tool numbers them.
 */
@Injectable()
export class CsvExtractor implements FormatExtractor {
  readonly id = 'csv';
  readonly formats = ['csv'] as const;

  constructor(private readonly config: AppConfigService) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- as above
  async extract(context: ExtractorContext): Promise<ReturnType<BlockBuilder['build']>> {
    const builder = new BlockBuilder(this.config.extraction.maxBlocks);
    const { text, guessed } = decodeText(context.content);

    if (guessed) {
      builder.warn(
        'ENCODING_GUESSED',
        'This file does not declare its character encoding, so one was inferred. Check any unusual characters.',
      );
    }

    const delimiter = detectDelimiter(text);
    const rows = parseDelimited(normaliseText(text), delimiter);

    if (rows.length === 0) {
      throw new FileExtractionError('empty_document', 'The file contains no rows.', false);
    }

    const maxRows = this.config.extraction.maxRows;
    const header = rows[0] ?? [];
    let sawFormula = false;

    if (rows.length > maxRows) {
      builder.warn(
        'TRUNCATED_ROWS',
        `This file has ${rows.length.toLocaleString()} rows. The first ${maxRows.toLocaleString()} were read.`,
      );
    }

    rows.slice(0, maxRows).forEach((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;

      // The header becomes its own block: it is what gives every later row its
      // meaning, and a citation of "row 14, Priority column" needs it present.
      const kind = rowIndex === 0 ? 'heading' : 'table_row';
      const rendered = cells
        .map((cell, columnIndex) => {
          if (isFormula(cell)) {
            sawFormula = true;
          }

          const label = rowIndex === 0 ? undefined : header[columnIndex]?.trim();
          const value = cell.trim();

          return label && label.length > 0 ? `${label}: ${value}` : value;
        })
        .filter((part) => part.length > 0 && !part.endsWith(': '))
        .join(' | ');

      builder.add(kind, rendered, { rowNumber });
    });

    if (sawFormula) {
      builder.warn(
        'FORMULA_NOT_EVALUATED',
        'Some cells contain formulas. They are shown exactly as written and are never calculated.',
      );
    }

    return builder.build('csv');
  }
}

/** A cell that a spreadsheet application would treat as a formula. */
export function isFormula(value: string): boolean {
  return /^[=+\-@]/.test(value.trim());
}

/**
 * Picks a delimiter by counting candidates outside quotes.
 *
 * Declaring CSV to be comma-separated would be simpler and wrong: European
 * exports are semicolon-separated as a matter of locale, and reading one as a
 * single column per row produces requirements that are technically extracted and
 * practically useless.
 */
export function detectDelimiter(text: string): string {
  const sample = text.split('\n').slice(0, 20).join('\n');
  const candidates = [',', ';', '\t', '|'];

  let best = ',';
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = countOutsideQuotes(sample, candidate);

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function countOutsideQuotes(text: string, character: string): number {
  let count = 0;
  let inQuotes = false;

  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === character) {
      count += 1;
    }
  }

  return count;
}

/**
 * RFC 4180 parsing, by hand.
 *
 * A dependency would do this too, and the reason not to take one is narrow: the
 * grammar is small, the behaviour on malformed input matters (a client's export
 * is often slightly wrong, and it should still be read rather than throw), and
 * this is a place where a supply-chain addition buys very little.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Blank trailing lines are an artefact of how files end, not data.
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

/**
 * Decodes bytes to text, detecting the common encodings by byte-order mark.
 *
 * Where there is no mark, UTF-8 is assumed and the caller is told it was a
 * guess. That honesty matters: a Windows-1252 file read as UTF-8 produces
 * mangled accented characters, and the user needs to know to look for them
 * rather than discovering them in a signed document.
 */
export function decodeText(content: Buffer): { text: string; guessed: boolean } {
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    return { text: content.subarray(3).toString('utf8'), guessed: false };
  }

  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return { text: content.subarray(2).toString('utf16le'), guessed: false };
  }

  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    // Node has no UTF-16BE decoder; swapping to LE is the standard workaround.
    const swapped = Buffer.from(content.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), guessed: false };
  }

  const decoded = content.toString('utf8');
  // A replacement character means the bytes were not valid UTF-8, so the
  // encoding is genuinely unknown rather than merely undeclared.
  const invalid = decoded.includes('\uFFFD');

  if (invalid) {
    return { text: content.toString('latin1'), guessed: true };
  }

  return { text: decoded, guessed: false };
}
