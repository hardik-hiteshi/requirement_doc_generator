import { spreadsheetSafeText } from '@wdrg/contracts';
import ExcelJS from 'exceljs';

import type { ExportMetadata } from '@wdrg/contracts';

import type { TableProjection } from '../export-projection';

/**
 * A real `.xlsx` workbook, written locally.
 *
 * Two sheets: the data, and a short sheet saying which version of which document this is.
 * The metadata goes on its own sheet rather than as rows above the header, because rows
 * above a header break every importer that expects the header first — the Feature
 * Listing's contract says the header is the first line, and that stays true.
 *
 * Cells are typed. Hours are numbers, so a client's SUM matches the estimate; ids are text,
 * so `AC-001` is not turned into a date and `007` keeps its zeros. Nothing is a formula:
 * the workbook carries values the document already calculated, so there is no arithmetic to
 * get wrong on somebody else's machine and no macro anywhere in the file.
 */

/** Formats a spreadsheet applies to a cell. Hours to two decimals, exact. */
const HOURS_FORMAT = '0.##';
const DATE_FORMAT = 'yyyy-mm-dd';

export async function renderXlsx(input: {
  readonly projection: TableProjection;
  readonly metadata: ExportMetadata;
  readonly accentColor: string;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = input.metadata.organizationName ?? 'Requirement Documentation Generator';
  workbook.created = new Date(input.metadata.exportedAt);

  const sheet = workbook.addWorksheet(input.projection.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = input.projection.columns.map((column) => ({
    header: column.header,
    width: column.width ?? 20,
  }));

  /* The accent is decoration on the header row only; body text stays black on white. */
  const headerFill = input.accentColor.replace('#', '').toUpperCase();

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${headerFill}` } };
  });

  for (const row of input.projection.rows) {
    const added = sheet.addRow(
      row.map((value) => {
        switch (value.kind) {
          case 'empty':
            return null;
          case 'number':
            return value.value;
          case 'date':
            return value.value;
          case 'text':
            /* Same neutralisation as the CSV: a cell is data, never an instruction. */
            return spreadsheetSafeText(value.value);
        }
      }),
    );

    added.eachCell((cell, column) => {
      const source = row[column - 1];

      if (source?.kind === 'number') {
        cell.numFmt = HOURS_FORMAT;
      }

      if (source?.kind === 'date') {
        cell.numFmt = DATE_FORMAT;
      }

      if (source?.kind === 'text') {
        cell.alignment = { vertical: 'top', wrapText: true };
      }
    });
  }

  const about = workbook.addWorksheet('About this export');

  about.columns = [
    { header: 'Field', width: 24 },
    { header: 'Value', width: 80 },
  ];

  const aboutRows: readonly (readonly [string, string])[] = [
    ['Project', input.metadata.projectName],
    ['Document', input.metadata.documentLabel],
    ['Version', `v${input.metadata.documentVersion}`],
    ['Status', input.metadata.statusLabel],
    ['Up to date', input.metadata.outdated ? 'No — see below' : 'Yes'],
    ['Exported', input.metadata.exportedAt],
    ...(input.metadata.organizationName
      ? ([['Organisation', input.metadata.organizationName]] as const)
      : []),
    ...input.metadata.outdatedReasons.map((reason): readonly [string, string] => [
      'Since this version',
      reason,
    ]),
  ];

  for (const [field, value] of aboutRows) {
    about.addRow([field, spreadsheetSafeText(value)]);
  }

  about.getRow(1).font = { bold: true };

  const written = await workbook.xlsx.writeBuffer();

  return Buffer.from(written);
}
