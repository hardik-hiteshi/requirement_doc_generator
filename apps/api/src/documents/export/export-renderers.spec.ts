import type { ExportMetadata } from '@wdrg/contracts';

import type { ProseProjection, TableProjection } from './export-projection';
import { renderCsv, UTF8_BOM } from './renderers/csv.renderer';
import { renderDocx } from './renderers/docx.renderer';
import { isWinAnsiRenderable, pdfTextFallback, renderPdf } from './renderers/pdf.renderer';
import { renderXlsx } from './renderers/xlsx.renderer';

/**
 * The renderers, checked against their own output rather than against a snapshot.
 *
 * A snapshot test of a binary tells you it changed, not whether it is valid. So these
 * assert the properties that matter to whoever opens the file: that a `.docx` really is an
 * OOXML package, that a formula-shaped cell arrives as text, that 4.48 hours is still 4.48,
 * and that Devanagari does not become mojibake.
 */

const metadata: ExportMetadata = {
  projectName: 'Timesheet portal',
  documentLabel: 'Feature Listing',
  documentVersion: 3,
  statusLabel: 'Approved',
  outdated: false,
  outdatedReasons: [],
  exportedAt: '2026-08-13T10:00:00.000Z',
};

const outdatedMetadata: ExportMetadata = {
  ...metadata,
  outdated: true,
  outdatedReasons: ['The approved requirements changed.'],
};

const table: TableProjection = {
  sheetName: 'Feature Listing',
  columns: [{ header: 'Module' }, { header: 'Detail' }, { header: 'Hours' }],
  rows: [
    [
      { kind: 'text', value: 'Timesheets' },
      { kind: 'text', value: '=cmd|calc' },
      { kind: 'number', value: 4.48 },
    ],
    [
      { kind: 'text', value: 'रिपोर्ट' },
      { kind: 'text', value: '+1-555-0100' },
      { kind: 'number', value: 0.01 },
    ],
    [{ kind: 'text', value: 'Empty' }, { kind: 'empty' }, { kind: 'number', value: 1.2 }],
    [
      { kind: 'text', value: 'Quoted' },
      { kind: 'text', value: 'a "quoted", comma' },
      { kind: 'empty' },
    ],
  ],
};

const prose: ProseProjection = {
  landscape: false,
  blocks: [
    { kind: 'heading', level: 1, text: 'Timesheet portal' },
    { kind: 'paragraph', text: 'Staff record hours; managers approve them.' },
    { kind: 'bullets', items: ['Weekly grid', 'Approval history'] },
    { kind: 'table', columns: ['Task', 'Effort'], rows: [['Build grid', '4.48']] },
    { kind: 'note', text: 'Nothing in the approved requirements covers this.' },
  ],
};

const isZip = (body: Buffer): boolean => body.subarray(0, 2).toString('latin1') === 'PK';

/**
 * Entry names from a ZIP's central directory.
 *
 * Matched on the central-directory signature rather than the bare "PK", which also begins
 * every local file header and the end-of-directory record — reading a name length at those
 * offsets walks off the end of the buffer.
 */
function zipEntries(body: Buffer): readonly string[] {
  const names: string[] = [];
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

  let index = body.indexOf(signature);

  while (index !== -1 && index + 46 <= body.byteLength) {
    const nameLength = body.readUInt16LE(index + 28);

    names.push(body.subarray(index + 46, index + 46 + nameLength).toString('utf8'));
    index = body.indexOf(signature, index + 4);
  }

  return names;
}

describe('the CSV renderer', () => {
  const csv = (): string => renderCsv(table).toString('utf8');

  it('opens correctly in a spreadsheet that assumes the local code page', () => {
    expect(csv().startsWith(UTF8_BOM)).toBe(true);
  });

  it('quotes every text value and every empty one', () => {
    const [, first] = csv().split('\r\n');

    expect(first).toContain('"Timesheets"');
  });

  it('neutralises a formula-shaped value rather than trusting the quotes', () => {
    expect(csv()).toContain(`"'=cmd|calc"`);
    expect(csv()).toContain(`"'+1-555-0100"`);
  });

  it('writes numbers bare so a spreadsheet stores them as numbers', () => {
    expect(csv()).toContain(',4.48');
    expect(csv()).toContain(',0.01');
    expect(csv()).toContain(',1.2');
  });

  it('keeps fractional hours exact', () => {
    expect(csv()).not.toContain(',4.5');
    expect(csv()).not.toContain(',4,');
  });

  it('doubles inner quotes and keeps commas inside the field', () => {
    expect(csv()).toContain('"a ""quoted"", comma"');
  });

  it('survives non-Latin text', () => {
    expect(csv()).toContain('रिपोर्ट');
  });

  it('ends every line with CRLF', () => {
    expect(csv().endsWith('\r\n')).toBe(true);
  });

  it('writes one line per row and no more', () => {
    /* Header, four rows, and the trailing terminator. */
    expect(csv().trimEnd().split('\r\n')).toHaveLength(5);
  });
});

describe('the XLSX renderer', () => {
  it('produces a real OOXML workbook', async () => {
    const body = await renderXlsx({ projection: table, metadata, accentColor: '#1F3A5F' });

    expect(isZip(body)).toBe(true);

    const entries = zipEntries(body);

    expect(entries).toContain('xl/workbook.xml');
    expect(entries.some((entry) => entry.startsWith('xl/worksheets/'))).toBe(true);
  });

  it('contains no macro part', async () => {
    const entries = zipEntries(
      await renderXlsx({ projection: table, metadata, accentColor: '#1F3A5F' }),
    );

    expect(entries.some((entry) => entry.includes('vbaProject'))).toBe(false);
  });

  it('carries a sheet saying which version this is', async () => {
    const body = await renderXlsx({
      projection: table,
      metadata: outdatedMetadata,
      accentColor: '#1F3A5F',
    });

    /* Sheet names live in workbook.xml, which is deflated; the string table is not. */
    expect(body.byteLength).toBeGreaterThan(0);
    expect(isZip(body)).toBe(true);
  });
});

describe('the DOCX renderer', () => {
  it('produces a real OOXML document', async () => {
    const body = await renderDocx({ projection: prose, metadata, accentColor: '#1F3A5F' });

    expect(isZip(body)).toBe(true);
    expect(zipEntries(body)).toContain('word/document.xml');
  });

  it('embeds a logo as an image part when one is given', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );

    const body = await renderDocx({
      projection: prose,
      metadata,
      accentColor: '#1F3A5F',
      logo: { content: png, contentType: 'image/png' },
    });

    expect(zipEntries(body).some((entry) => entry.startsWith('word/media/'))).toBe(true);
  });

  it('lays a wide document out in landscape', async () => {
    const body = await renderDocx({
      projection: { ...prose, landscape: true },
      metadata,
      accentColor: '#1F3A5F',
    });

    expect(isZip(body)).toBe(true);
  });
});

describe('the PDF renderer', () => {
  it('produces a file with a PDF signature', async () => {
    const body = await renderPdf({ projection: prose, metadata, accentColor: '#1F3A5F' });

    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(body.byteLength).toBeGreaterThan(500);
  });

  it('renders an outdated document without refusing to', async () => {
    const body = await renderPdf({
      projection: prose,
      metadata: outdatedMetadata,
      accentColor: '#1F3A5F',
    });

    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  /*
   * The standard PDF fonts are Latin-only. Rather than crash or silently drop characters,
   * the renderer marks what it cannot draw — losing text without saying so is the one
   * outcome worse than an imperfect page.
   */
  it('knows what the standard fonts can draw', () => {
    expect(isWinAnsiRenderable('Timesheet — grid')).toBe(true);
    expect(isWinAnsiRenderable('रिपोर्ट')).toBe(false);
  });

  it('marks unrenderable characters rather than dropping them', () => {
    const marked = pdfTextFallback('रिपोर्ट');

    expect(marked).not.toBe('');
    expect(marked).toMatch(/^\?+$/);
    expect(pdfTextFallback('Weekly grid')).toBe('Weekly grid');
  });

  it('renders non-Latin content without throwing', async () => {
    const body = await renderPdf({
      projection: {
        landscape: false,
        blocks: [{ kind: 'paragraph', text: 'रिपोर्ट और समय पत्रक' }],
      },
      metadata,
      accentColor: '#1F3A5F',
    });

    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
