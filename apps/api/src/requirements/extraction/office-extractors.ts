import type * as ExcelJsModule from 'exceljs';
import type { Cell } from 'exceljs';
import type * as MammothModule from 'mammoth';

import { Injectable, Logger } from '@nestjs/common';
import type { ExtractedContent } from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import { FileExtractionError } from '../../ports';
import { BlockBuilder, normaliseText } from './block-builder';
import type { ExtractorContext, FormatExtractor } from './extractor.types';
import { isFormula } from './text-extractors';

/**
 * DOCX, via mammoth.
 *
 * mammoth converts to semantic HTML rather than to a flat string, which is the
 * property that matters: headings stay headings, list items stay list items, and
 * table cells stay in their rows. Flattening to text would lose the structure a
 * requirement document carries most of its meaning in — "3.2 Non-functional
 * requirements" is not the same evidence as a paragraph that happens to say it.
 *
 * Macros are never a concern here because mammoth reads the document XML and has
 * no execution model at all. There is nothing to disable, which is a stronger
 * position than having disabled it.
 */
@Injectable()
export class DocxExtractor implements FormatExtractor {
  readonly id = 'docx';
  readonly formats = ['docx'] as const;
  private readonly logger = new Logger(DocxExtractor.name);

  constructor(private readonly config: AppConfigService) {}

  async extract(context: ExtractorContext): Promise<ExtractedContent> {
    const builder = new BlockBuilder(this.config.extraction.maxBlocks);

    // Required lazily: mammoth pulls in a large dependency tree, and an API that
    // never receives a DOCX should not pay for it at startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth') as typeof MammothModule;

    let html: string;
    let messages: readonly { type: string; message: string }[];

    try {
      const result = await mammoth.convertToHtml({ buffer: context.content });
      html = result.value;
      messages = result.messages;
    } catch (cause) {
      this.logger.warn({ cause, sourceId: context.sourceId }, 'DOCX conversion failed');
      throw new FileExtractionError('corrupted_file', 'The document could not be opened.', false, {
        cause,
      });
    }

    if (messages.some((message) => message.type === 'error')) {
      builder.warn(
        'PARTIAL_EXTRACTION',
        'Parts of this document could not be read and are missing from the extracted content.',
      );
    }

    let currentHeading: string | undefined;
    let paragraphIndex = 0;

    for (const element of parseHtmlElements(html)) {
      if (builder.isFull) {
        break;
      }

      const text = normaliseText(decodeEntities(element.text)).trim();

      if (text.length === 0) {
        continue;
      }

      const reference = {
        paragraphIndex,
        ...(currentHeading ? { heading: currentHeading } : {}),
      };

      switch (element.tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          currentHeading = text;
          builder.add(
            'heading',
            text,
            { paragraphIndex },
            {
              level: Number(element.tag.slice(1)),
            },
          );
          break;
        case 'li':
          builder.add('list_item', text, reference);
          break;
        case 'td':
        case 'th':
          builder.add('cell', text, reference);
          break;
        case 'tr':
          builder.add('table_row', text, reference);
          break;
        default:
          builder.add('paragraph', text, reference);
      }

      paragraphIndex += 1;
    }

    if (builder.blockCount === 0) {
      throw new FileExtractionError(
        'empty_document',
        'The document contains no readable text.',
        false,
      );
    }

    return builder.build('docx');
  }
}

/**
 * XLSX, via exceljs.
 *
 * Formulas are read as text and never evaluated — exceljs exposes the formula
 * string and its cached result separately, and this takes the string. A
 * spreadsheet from a client is evidence about what they want, not a program to
 * run, and evaluating it would make an uploaded file into an execution path.
 *
 * Hidden sheets are skipped and the fact is reported. They are usually working
 * notes or a lookup table the author did not intend to send; silently including
 * them would put content into a requirement baseline that nobody meant to
 * provide, and silently dropping them would hide that it happened.
 */
@Injectable()
export class XlsxExtractor implements FormatExtractor {
  readonly id = 'xlsx';
  readonly formats = ['xlsx'] as const;
  private readonly logger = new Logger(XlsxExtractor.name);

  constructor(private readonly config: AppConfigService) {}

  async extract(context: ExtractorContext): Promise<ExtractedContent> {
    const builder = new BlockBuilder(this.config.extraction.maxBlocks);
    const limits = this.config.extraction;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExcelJS = require('exceljs') as typeof ExcelJsModule;
    const workbook = new ExcelJS.Workbook();

    try {
      await workbook.xlsx.load(context.content as unknown as ArrayBuffer);
    } catch (cause) {
      this.logger.warn({ cause, sourceId: context.sourceId }, 'XLSX load failed');
      throw new FileExtractionError(
        'corrupted_file',
        'The spreadsheet could not be opened.',
        false,
        { cause },
      );
    }

    const sheetNames: string[] = [];
    let sawFormula = false;
    let sawMerged = false;

    for (const worksheet of workbook.worksheets) {
      if (builder.isFull) {
        break;
      }

      if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') {
        builder.warn(
          'HIDDEN_SHEET_SKIPPED',
          'This workbook contains hidden sheets. They were not read — unhide them and upload again if they hold requirements.',
        );
        continue;
      }

      sheetNames.push(worksheet.name);

      const rowCount = Math.min(worksheet.rowCount, limits.maxRows);

      if (worksheet.rowCount > limits.maxRows) {
        builder.warn(
          'TRUNCATED_ROWS',
          `Sheet "${worksheet.name}" has ${worksheet.rowCount.toLocaleString()} rows. The first ${limits.maxRows.toLocaleString()} were read.`,
        );
      }

      for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
        if (builder.isFull) {
          break;
        }

        const row = worksheet.getRow(rowNumber);
        const values: string[] = [];
        let firstColumn = 0;
        let lastColumn = 0;

        row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          const rendered = renderCell(cell);

          if (rendered.isFormula) {
            sawFormula = true;
          }

          if (rendered.isMerged) {
            sawMerged = true;
          }

          if (rendered.text.length > 0) {
            values.push(rendered.text);
            firstColumn = firstColumn === 0 ? columnNumber : firstColumn;
            lastColumn = columnNumber;
          }
        });

        if (values.length === 0) {
          continue;
        }

        const cellRange =
          firstColumn === lastColumn
            ? `${columnLetter(firstColumn)}${rowNumber}`
            : `${columnLetter(firstColumn)}${rowNumber}:${columnLetter(lastColumn)}${rowNumber}`;

        builder.add('table_row', values.join(' | '), {
          sheetName: worksheet.name,
          rowNumber,
          cellRange,
        });
      }
    }

    if (sawFormula) {
      builder.warn(
        'FORMULA_NOT_EVALUATED',
        'Some cells contain formulas. They are shown exactly as written and are never calculated.',
      );
    }

    if (sawMerged) {
      builder.warn(
        'MERGED_CELLS_FLATTENED',
        'Merged cells were read as a single value on their first row, so a merged heading may not repeat down its rows.',
      );
    }

    if (builder.blockCount === 0) {
      throw new FileExtractionError(
        'empty_document',
        'The spreadsheet contains no readable cells.',
        false,
      );
    }

    return builder.build('xlsx', { sheetNames });
  }
}

interface RenderedCell {
  readonly text: string;
  readonly isFormula: boolean;
  readonly isMerged: boolean;
}

/**
 * A cell as text, without ever evaluating it.
 *
 * exceljs models values as a union — a string, a number, a date, a rich-text
 * run, a hyperlink, a formula with a cached result. Each is handled explicitly
 * because the fallbacks are wrong in different ways: `String(value)` on a
 * formula object produces `[object Object]`, and on a date produces a locale
 * string nobody asked for.
 */
function renderCell(cell: Cell): RenderedCell {
  const isMerged = cell.isMerged;
  const value: unknown = cell.value;

  if (value === null || value === undefined) {
    return { text: '', isFormula: false, isMerged };
  }

  if (typeof value === 'string') {
    // A string cell can still *be* a formula in a CSV-ish sense; flagged so the
    // warning is accurate for both spreadsheet formats.
    return { text: value.trim(), isFormula: isFormula(value), isMerged };
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return { text: String(value), isFormula: false, isMerged };
  }

  if (value instanceof Date) {
    return { text: value.toISOString().slice(0, 10), isFormula: false, isMerged };
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (typeof record.formula === 'string') {
      // The formula text, not its cached result. Keeping the expression is what
      // makes "this total is computed" visible to a reviewer.
      return { text: `=${record.formula}`, isFormula: true, isMerged };
    }

    if (typeof record.result === 'string' || typeof record.result === 'number') {
      return { text: String(record.result), isFormula: true, isMerged };
    }

    if (Array.isArray(record.richText)) {
      const runs = record.richText as { text?: unknown }[];
      return {
        text: runs.map((run) => (typeof run.text === 'string' ? run.text : '')).join(''),
        isFormula: false,
        isMerged,
      };
    }

    if (typeof record.text === 'string') {
      return { text: record.text, isFormula: false, isMerged };
    }

    if (typeof record.hyperlink === 'string') {
      return { text: record.hyperlink, isFormula: false, isMerged };
    }
  }

  return { text: '', isFormula: false, isMerged };
}

/** 1 -> A, 27 -> AA. Spreadsheet column notation. */
export function columnLetter(index: number): string {
  let remaining = index;
  let letters = '';

  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + modulo) + letters;
    remaining = Math.floor((remaining - modulo) / 26);
  }

  return letters;
}

interface HtmlElement {
  readonly tag: string;
  readonly text: string;
}

/**
 * Pulls block-level elements out of mammoth's HTML.
 *
 * A regular expression rather than an HTML parser, and that is a deliberate
 * narrowing: the input is not arbitrary HTML from the internet, it is mammoth's
 * own output, whose shape is a small, known set of block tags with no
 * attributes, no scripts and no nesting surprises. A full parser would be a
 * dependency defending against inputs that cannot occur here.
 */
export function parseHtmlElements(html: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  const pattern = /<(h[1-6]|p|li|td|th)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;

  let match = pattern.exec(html);

  while (match !== null) {
    const tag = (match[1] ?? '').toLowerCase();
    const inner = (match[2] ?? '').replace(/<[^>]+>/g, ' ');

    elements.push({ tag, text: inner });
    match = pattern.exec(html);
  }

  return elements;
}

/** The five entities mammoth emits. Nothing else appears in its output. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
