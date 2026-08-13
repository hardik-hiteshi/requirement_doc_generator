import {
  CSV_ROLE_COLUMNS,
  DETAIL_SEPARATOR,
  OTHER_ROLE_LABELS,
  otherRoleEffort,
  type FeatureRow,
} from './feature-listing.contract';
import { spreadsheetSafeText } from './spreadsheet-safe';

/**
 * The strict Feature Listing export.
 *
 * ## The header is a contract, not a preference
 *
 * Eight columns, in this order, spelled exactly like this — including
 * `"Estimated Hours - Other Roles (mention role)"` with its parenthetical, and
 * the hyphen rather than an en dash. Somebody's spreadsheet, template or import
 * script keys off these strings. A "tidier" header is a broken integration, so
 * the header is a frozen constant and a test compares it character for character.
 *
 * ## Every value is quoted
 *
 * Not only the ones that need it. A file where quoting depends on content is a
 * file where a diff of two exports is noise, and where a description that gains
 * a comma changes the shape of the line. Uniform quoting makes the output
 * stable, and the escaping rule — a literal `"` becomes `""` — is RFC 4180.
 *
 * ## Emptiness is meaningful
 *
 * A blank `Screen` is written as `""` rather than omitted. An API endpoint has no
 * screen, and the honest cell is empty; calling it "API Screen" to avoid a blank
 * would put a fabrication in a client document.
 */

/** The eight columns, in export order. Frozen. */
export const FEATURE_CSV_COLUMNS = [
  'Module',
  'Sub Module',
  'Screen',
  'Detailed Feature Description',
  'Estimated Hours - Backend Dev',
  'Estimated Hours - Frontend Dev',
  'Estimated Hours - QA',
  'Estimated Hours - Other Roles (mention role)',
] as const;

export type FeatureCsvColumn = (typeof FEATURE_CSV_COLUMNS)[number];

/** The header line, already quoted. */
export const FEATURE_CSV_HEADER = FEATURE_CSV_COLUMNS.map((column) => `"${column}"`).join(',');

/** `\r\n`, because the consumer is a spreadsheet. RFC 4180. */
export const CSV_LINE_ENDING = '\r\n';

/**
 * One CSV field: always quoted, inner quotes doubled.
 *
 * Newlines inside a description are collapsed to a space rather than preserved.
 * A quoted field may legally contain a newline, but every second consumer
 * mishandles it, and a feature description spanning lines in a spreadsheet cell
 * is unreadable anyway — the pipe separator is what carries multiple points.
 */
export function csvField(value: string): string {
  const flattened = value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  /*
   * Neutralised before quoting, because quoting is not protection.
   *
   * The quotes below are CSV's escaping, stripped by the parser before the spreadsheet
   * decides what a cell means — so `"=1+1"` still opens as a formula. A module or feature
   * description is user text, and user text starting `=` in a file a client double-clicks
   * is a hazard the export owns. See `spreadsheetSafeText`: ordinary values pass through
   * untouched, so the eight-column contract and every existing value are unchanged.
   */
  return `"${spreadsheetSafeText(flattened).replace(/"/g, '""')}"`;
}

/** An hours figure for a cell. Blank when the role has no work on this row. */
export function csvHours(hours: number | undefined): string {
  if (hours === undefined || hours <= 0) {
    return '';
  }

  // Whole hours read as whole numbers; halves keep one decimal. A trailing
  // ".00" in a client-facing sheet looks like machine output.
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

/**
 * The "Other Roles" cell: `"Mobile Dev: 12 | UI/UX: 4"`.
 *
 * Named, because "Other: 16" tells a reader nothing they can act on — the whole
 * point of the parenthetical in the column title is that the role is mentioned.
 */
export function otherRolesCell(row: Pick<FeatureRow, 'effort'>): string {
  return otherRoleEffort(row.effort)
    .map(({ role, hours }) => `${OTHER_ROLE_LABELS[role] ?? role}: ${csvHours(hours)}`)
    .join(` ${DETAIL_SEPARATOR} `);
}

/**
 * Multiple description points into one cell, separated by `|`.
 *
 * Accepts either a list or a single string. A string already containing the
 * separator passes through unchanged, so a description written by hand with
 * pipes in it survives a round trip.
 */
export function joinDetailPoints(points: readonly string[]): string {
  return points
    .map((point) => point.trim())
    .filter((point) => point.length > 0)
    .join(` ${DETAIL_SEPARATOR} `);
}

/** Splits a cell back into its points. The inverse of `joinDetailPoints`. */
export function splitDetailPoints(value: string): readonly string[] {
  return value
    .split(DETAIL_SEPARATOR)
    .map((point) => point.trim())
    .filter((point) => point.length > 0);
}

/** One row, projected onto the eight columns. */
export function featureCsvRow(row: FeatureRow): string {
  return [
    csvField(row.module),
    csvField(row.submodule),
    csvField(row.screen),
    csvField(row.description),
    csvField(csvHours(row.effort[CSV_ROLE_COLUMNS[0]])),
    csvField(csvHours(row.effort[CSV_ROLE_COLUMNS[1]])),
    csvField(csvHours(row.effort[CSV_ROLE_COLUMNS[2]])),
    csvField(otherRolesCell(row)),
  ].join(',');
}

/**
 * The whole document as strict CSV.
 *
 * Rows keep their stored order — which is the order a person sees and can
 * rearrange — rather than being sorted here. A sheet whose order changes on
 * every export is a sheet nobody can review twice.
 */
export function featureListingCsv(rows: readonly FeatureRow[]): string {
  return [FEATURE_CSV_HEADER, ...rows.map(featureCsvRow)].join(CSV_LINE_ENDING) + CSV_LINE_ENDING;
}

/**
 * Checks a serialised document against the frozen schema.
 *
 * Exists so the API can assert its own output rather than trusting it, and so
 * the browser suite can check what a user would actually download.
 */
export function validateFeatureCsv(
  csv: string,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  const lines = csv.split(CSV_LINE_ENDING).filter((line) => line.length > 0);
  const header = lines[0];

  if (header !== FEATURE_CSV_HEADER) {
    return { valid: false, reason: 'The header does not match the strict schema.' };
  }

  for (const [index, line] of lines.slice(1).entries()) {
    const fields = splitCsvLine(line);

    if (fields === null) {
      return { valid: false, reason: `Row ${index + 1} is not correctly quoted.` };
    }

    if (fields.length !== FEATURE_CSV_COLUMNS.length) {
      return {
        valid: false,
        reason: `Row ${index + 1} has ${fields.length} fields; the schema has ${FEATURE_CSV_COLUMNS.length}.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Splits one strict line, requiring every field to be quoted.
 *
 * Returns null on anything this serialiser would never emit — an unquoted field,
 * an unterminated quote — which is what makes the validator able to fail.
 */
function splitCsvLine(line: string): readonly string[] | null {
  const fields: string[] = [];
  let index = 0;

  while (index < line.length) {
    if (line[index] !== '"') {
      return null;
    }

    index += 1;
    let value = '';

    for (;;) {
      if (index >= line.length) {
        return null;
      }

      if (line[index] === '"') {
        if (line[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }

        index += 1;
        break;
      }

      value += line[index];
      index += 1;
    }

    fields.push(value);

    if (index === line.length) {
      break;
    }

    if (line[index] !== ',') {
      return null;
    }

    index += 1;

    // A trailing comma means an unquoted empty final field, which this
    // serialiser never emits.
    if (index === line.length) {
      return null;
    }
  }

  return fields;
}
