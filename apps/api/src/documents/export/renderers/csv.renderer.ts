import { spreadsheetSafeText } from '@wdrg/contracts';

import type { CellValue, TableProjection } from '../export-projection';

/**
 * RFC 4180 CSV, UTF-8, with formula-shaped text neutralised.
 *
 * Every value is quoted, as the Feature Listing's strict export established: a file whose
 * quoting depends on content produces diffs full of noise and lines that change shape when
 * a description gains a comma. Uniform quoting is stable.
 *
 * Quoting is not protection, though. It is CSV's escaping, undone by the parser before the
 * spreadsheet decides what a cell means, so `=cmd|...` still opens as a formula. Text is
 * therefore neutralised first and quoted second.
 *
 * A byte-order mark is written because Excel on Windows otherwise reads UTF-8 as the local
 * code page and mangles every accented character and every rupee sign in the file.
 */

export const CSV_LINE_ENDING = '\r\n';
export const UTF8_BOM = '﻿';

function cell(value: CellValue): string {
  switch (value.kind) {
    case 'empty':
      return '""';
    case 'number':
      /* Bare, so a spreadsheet stores a number rather than a string that looks like one. */
      return String(value.value);
    case 'date':
      return `"${value.value.toISOString().slice(0, 10)}"`;
    case 'text': {
      const flattened = value.value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

      return `"${spreadsheetSafeText(flattened).replace(/"/g, '""')}"`;
    }
  }
}

export function renderCsv(projection: TableProjection): Buffer {
  const header = projection.columns.map((column) => `"${column.header}"`).join(',');
  const rows = projection.rows.map((row) => row.map(cell).join(','));

  return Buffer.from(
    `${UTF8_BOM}${[header, ...rows].join(CSV_LINE_ENDING)}${CSV_LINE_ENDING}`,
    'utf8',
  );
}
