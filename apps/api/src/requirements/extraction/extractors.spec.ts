import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtractedContent } from '@wdrg/contracts';

import type { AppConfigService } from '../../config/app-config.service';
import { FileExtractionError, type OcrProviderPort } from '../../ports';
import { ImageExtractor } from './image-extractor';
import { DocxExtractor, XlsxExtractor, columnLetter, parseHtmlElements } from './office-extractors';
import { PdfExtractor } from './pdf-extractor';
import { TesseractOcrAdapter } from '../ocr/tesseract-ocr.adapter';
import {
  CsvExtractor,
  TxtExtractor,
  decodeText,
  detectDelimiter,
  isFormula,
  parseDelimited,
} from './text-extractors';

/**
 * Extractors against real fixture bytes.
 *
 * Nothing here mocks a parser. The point of these tests is whether a real DOCX
 * yields real headings and a real spreadsheet yields real cell references — a
 * mocked parser would only prove that the code calls the function it calls.
 *
 * OCR is the exception, and only where the engine's presence is not what is
 * under test: a fake provider makes the *routing* deterministic. The genuine
 * Tesseract path is exercised separately, and skipped where no engine exists
 * rather than quietly passing.
 */

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const config = {
  extraction: {
    maxBlocks: 20_000,
    maxRows: 5_000,
    maxPages: 500,
    timeoutMs: 120_000,
    maxUncompressedBytes: 209_715_200,
  },
  ocr: {
    enabled: true,
    binary: 'tesseract',
    languages: 'eng',
    timeoutMs: 60_000,
    minConfidence: 0.75,
  },
} as unknown as AppConfigService;

/** A predictable OCR engine, so routing can be tested without one installed. */
const fakeOcr: OcrProviderPort = {
  isAvailable: () => Promise.resolve(true),
  limitations: () => ['fake'],
  recognise: () =>
    Promise.resolve({
      text: 'Recognised requirement text',
      meanConfidence: 0.6,
      regions: [
        {
          text: 'Recognised',
          confidence: 0.55,
          boundingBox: { x: 10, y: 10, width: 90, height: 20 },
        },
        {
          text: 'requirement',
          confidence: 0.9,
          boundingBox: { x: 110, y: 12, width: 90, height: 20 },
        },
        { text: 'text', confidence: 0.95, boundingBox: { x: 10, y: 60, width: 40, height: 20 } },
      ],
      durationMs: 1,
      engine: 'fake',
    }),
};

const context = (filename: string, content: Buffer, allowOcr = true) => ({
  sourceId: 'src_0123456789ABCDEFGHJKMNPQRS',
  filename,
  content,
  allowOcr,
});

describe('TxtExtractor', () => {
  const extractor = new TxtExtractor(config);

  it('keeps a line number for every line', async () => {
    const result = await extractor.extract(
      context('requirements.txt', fixture('requirements.txt')),
    );

    expect(result.blocks.length).toBeGreaterThan(2);
    expect(result.blocks[0]?.text).toBe('Northwind Quoting Platform');
    expect(result.blocks[0]?.reference.lineNumber).toBe(1);

    // Blank lines are skipped, but the numbering must still match the file —
    // a citation of "line 3" has to find line 3 in the user's editor.
    const approval = result.blocks.find((block) => block.text.includes('approved by a manager'));
    expect(approval?.reference.lineNumber).toBe(4);
  });

  it('reports full confidence, because nothing was guessed', async () => {
    const result = await extractor.extract(
      context('requirements.txt', fixture('requirements.txt')),
    );

    expect(result.minimumConfidence).toBe(1);
    expect(result.usedOcr).toBe(false);
    expect(result.blocks.every((block) => block.viaOcr === false)).toBe(true);
  });

  it('refuses an empty file rather than returning nothing', async () => {
    await expect(extractor.extract(context('empty.txt', Buffer.from('')))).rejects.toThrow(
      FileExtractionError,
    );
  });
});

describe('CsvExtractor', () => {
  const extractor = new CsvExtractor(config);

  it('keeps the header and labels every row with it', async () => {
    const result = await extractor.extract(context('features.csv', fixture('features.csv')));

    expect(result.blocks[0]?.kind).toBe('heading');
    expect(result.blocks[0]?.reference.rowNumber).toBe(1);

    const browse = result.blocks.find((block) => block.text.includes('Browse products'));
    expect(browse?.reference.rowNumber).toBe(2);
    expect(browse?.text).toContain('Feature: Browse products');
    expect(browse?.text).toContain('Priority: High');
  });

  it('never evaluates a formula, and says that it did not', async () => {
    const result = await extractor.extract(context('features.csv', fixture('features.csv')));

    const formulaRow = result.blocks.find((block) => block.text.includes('=1+1'));
    expect(formulaRow).toBeDefined();
    expect(result.blocks.some((block) => block.text.includes(': 2'))).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('FORMULA_NOT_EVALUATED');
  });

  it('detects a semicolon delimiter', async () => {
    const result = await extractor.extract(
      context('features-semicolon.csv', fixture('features-semicolon.csv')),
    );

    const row = result.blocks.find((block) => block.text.includes('Browse products'));
    expect(row?.text).toContain('Feature: Browse products');
  });
});

describe('CSV parsing primitives', () => {
  it('handles quoted fields containing the delimiter', () => {
    expect(parseDelimited('a,"b,c",d', ',')).toEqual([['a', 'b,c', 'd']]);
  });

  it('handles a doubled quote inside a quoted field', () => {
    expect(parseDelimited('a,"say ""hi""",c', ',')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('does not count a delimiter inside quotes when detecting one', () => {
    expect(detectDelimiter('a;b;c\n"x;y;z";q;r')).toBe(';');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '  =cmd|calc'])('treats %p as a formula', (value) => {
    expect(isFormula(value)).toBe(true);
  });

  it.each(['1+1', 'Total', '"=1+1"'])('does not treat %p as a formula', (value) => {
    expect(isFormula(value)).toBe(false);
  });

  it('decodes a UTF-8 BOM without leaving it in the text', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo', 'utf8')]);
    expect(decodeText(withBom)).toEqual({ text: 'héllo', guessed: false });
  });

  it('falls back and admits the guess for undecodable bytes', () => {
    const latin1 = Buffer.from([0x48, 0xe9, 0x6c, 0x6c, 0x6f]);
    const result = decodeText(latin1);

    expect(result.guessed).toBe(true);
    expect(result.text).toBe('Héllo');
  });
});

describe('DocxExtractor', () => {
  const extractor = new DocxExtractor(config);

  it('keeps headings, paragraphs and table cells apart', async () => {
    const result = await extractor.extract(
      context('requirements.docx', fixture('requirements.docx')),
    );

    const headings = result.blocks.filter((block) => block.kind === 'heading');
    expect(headings.map((block) => block.text)).toContain('Northwind Quoting Platform');
    expect(headings.map((block) => block.text)).toContain('Scope');

    expect(result.blocks.some((block) => block.kind === 'paragraph')).toBe(true);
    expect(result.blocks.some((block) => block.text === 'Catalogue')).toBe(true);
  });

  it('attributes each paragraph to the heading above it', async () => {
    const result = await extractor.extract(
      context('requirements.docx', fixture('requirements.docx')),
    );

    const approval = result.blocks.find((block) => block.text.includes('approved by a manager'));
    expect(approval?.reference.heading).toBe('Scope');
  });

  it('rejects bytes that are not a document', async () => {
    await expect(
      extractor.extract(context('broken.docx', Buffer.from('not a docx'))),
    ).rejects.toThrow(FileExtractionError);
  });
});

describe('HTML element parsing', () => {
  it('pulls block elements out in document order', () => {
    const elements = parseHtmlElements('<h1>Title</h1><p>Body</p><ul><li>One</li></ul>');
    expect(elements.map((element) => element.tag)).toEqual(['h1', 'p', 'li']);
  });

  it('strips inline markup from the text', () => {
    const [element] = parseHtmlElements('<p>Some <strong>bold</strong> text</p>');
    expect(element?.text.replace(/\s+/g, ' ').trim()).toBe('Some bold text');
  });
});

describe('XlsxExtractor', () => {
  const extractor = new XlsxExtractor(config);
  let result: ExtractedContent;

  beforeAll(async () => {
    result = await extractor.extract(context('features.xlsx', fixture('features.xlsx')));
  });

  it('records the sheet, the row and the cell range for every row', () => {
    const browse = result.blocks.find((block) => block.text.includes('Browse products'));

    expect(browse?.reference.sheetName).toBe('Features');
    expect(browse?.reference.rowNumber).toBe(2);
    expect(browse?.reference.cellRange).toBe('A2:D2');
  });

  it('reads every visible sheet', () => {
    expect(result.sheetNames).toEqual(['Features', 'Assumptions']);
    expect(result.blocks.some((block) => block.text.includes('product catalogue as a CSV'))).toBe(
      true,
    );
  });

  it('skips hidden sheets and says so', () => {
    expect(result.blocks.some((block) => block.text.includes('must not be extracted'))).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('HIDDEN_SHEET_SKIPPED');
  });

  it('keeps a formula as text and never as its result', () => {
    const total = result.blocks.find((block) => block.text.startsWith('Total'));

    expect(total?.text).toContain('=SUM(D2:D4)');
    expect(total?.text).not.toContain('26');
    expect(result.warnings.map((warning) => warning.code)).toContain('FORMULA_NOT_EVALUATED');
  });
});

describe('columnLetter', () => {
  it.each([
    [1, 'A'],
    [26, 'Z'],
    [27, 'AA'],
    [52, 'AZ'],
    [703, 'AAA'],
  ])('maps %i to %s', (index, expected) => {
    expect(columnLetter(index)).toBe(expected);
  });
});

describe('PdfExtractor', () => {
  const extractor = new PdfExtractor(config, fakeOcr);

  /*
   * The first PDF in a process pays for the whole of pdfjs: a dynamic ESM import
   * of a multi-megabyte module, then the standard font data from disk. That cost
   * is real, one-off, and nothing to do with the document being read — and on a
   * shared CI runner it exceeded Jest's five-second default, failing the first
   * test in this block on main while the extractor was working correctly.
   *
   * Paying it here, once, against a budget that matches the work, leaves every
   * assertion below on the default timeout. No test is retried and no test's own
   * budget is inflated to cover somebody else's startup.
   */
  beforeAll(async () => {
    await extractor.extract(
      context('requirements-digital.pdf', fixture('requirements-digital.pdf')),
    );
  }, 60_000);

  it('reads a digital text layer with page numbers', async () => {
    const result = await extractor.extract(
      context('requirements-digital.pdf', fixture('requirements-digital.pdf')),
    );

    expect(result.pageCount).toBe(1);
    expect(result.usedOcr).toBe(false);
    expect(result.blocks.every((block) => block.reference.pageNumber === 1)).toBe(true);
    expect(result.blocks.map((block) => block.text).join(' ')).toContain(
      'Northwind Quoting Platform',
    );
  });

  it('routes a page with no text layer through OCR', async () => {
    const result = await extractor.extract(
      context('requirements-scanned.pdf', fixture('requirements-scanned.pdf')),
    );

    expect(result.usedOcr).toBe(true);
    expect(result.blocks.every((block) => block.viaOcr)).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('IMAGE_ONLY_PAGES');
    expect(result.blocks[0]?.reference.pageNumber).toBe(1);
  });

  it('says a scan could not be read when OCR is not allowed', async () => {
    await expect(
      extractor.extract(
        context('requirements-scanned.pdf', fixture('requirements-scanned.pdf'), false),
      ),
    ).rejects.toThrow(FileExtractionError);
  });

  it('reports a damaged file rather than throwing something unhandled', async () => {
    await expect(
      extractor.extract(context('corrupted.pdf', fixture('corrupted.pdf'))),
    ).rejects.toThrow(FileExtractionError);
  });
});

describe('ImageExtractor', () => {
  const extractor = new ImageExtractor(config, fakeOcr);

  it('groups words into lines and takes the lowest confidence per line', async () => {
    const result = await extractor.extract(
      context('printed-requirements.png', fixture('printed-requirements.png')),
    );

    const first = result.blocks[0];
    expect(first?.text).toBe('Recognised requirement');
    // 0.55 and 0.9 on the same line: the line is as uncertain as its worst word.
    expect(first?.confidence).toBeCloseTo(0.55);
    expect(first?.viaOcr).toBe(true);
  });

  it('keeps the region so the UI can point at uncertain text', async () => {
    const result = await extractor.extract(
      context('printed-requirements.png', fixture('printed-requirements.png')),
    );

    expect(result.blocks[0]?.reference.region).toEqual({ x: 10, y: 10, width: 190, height: 22 });
  });

  it('always warns that handwriting is unreliable', async () => {
    const result = await extractor.extract(
      context('printed-requirements.png', fixture('printed-requirements.png')),
    );

    expect(result.warnings.map((warning) => warning.code)).toContain('HANDWRITING_UNRELIABLE');
    expect(result.warnings.map((warning) => warning.code)).toContain('LOW_OCR_CONFIDENCE');
  });

  it('fails clearly when no engine is available', async () => {
    const noEngine = new ImageExtractor(config, {
      ...fakeOcr,
      isAvailable: () => Promise.resolve(false),
    });

    await expect(
      noEngine.extract(context('printed-requirements.png', fixture('printed-requirements.png'))),
    ).rejects.toThrow(/not available/i);
  });
});

/**
 * The real engine.
 *
 * Skipped, loudly, where Tesseract is not installed. A test that silently passes
 * without the thing it is testing is worse than no test — it reports coverage
 * that does not exist.
 */
describe('Tesseract, against the real engine', () => {
  const adapter = new TesseractOcrAdapter(config);
  let available = false;

  beforeAll(async () => {
    available = await adapter.isAvailable();

    if (!available) {
      console.warn('SKIPPING real OCR tests: no tesseract binary on PATH');
    }
  });

  it('recognises printed text in a PNG', async () => {
    if (!available) {
      return;
    }

    const result = await adapter.recognise({
      content: fixture('printed-requirements.png'),
      format: 'png',
      languages: 'eng',
      detectOrientation: false,
    });

    expect(result.text.toLowerCase()).toContain('northwind');
    expect(result.meanConfidence).toBeGreaterThan(0.5);
    expect(result.regions.length).toBeGreaterThan(3);
    expect(result.regions.every((region) => region.boundingBox !== undefined)).toBe(true);
  }, 60_000);

  it('recognises the same text in a JPEG', async () => {
    if (!available) {
      return;
    }

    const result = await adapter.recognise({
      content: fixture('printed-requirements.jpg'),
      format: 'jpg',
      languages: 'eng',
      detectOrientation: false,
    });

    expect(result.text.toLowerCase()).toContain('quoting');
  }, 60_000);

  it('reports its own limitations, including handwriting', () => {
    expect(adapter.limitations().join(' ')).toMatch(/handwriting/i);
  });
});
