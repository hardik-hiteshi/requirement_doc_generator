import {
  DOCUMENT_STATUS_LABELS,
  PROJECT_DOCUMENT_LABELS,
  type Branding,
  type DocumentSnapshot,
  type ExportMetadata,
  type ProjectDocument,
} from '@wdrg/contracts';

/**
 * The shape every renderer consumes, and the only thing they are allowed to know.
 *
 * A renderer's job is typography: turn blocks into a DOCX, turn a table into a sheet. It
 * must never ask what a work package is, which requirements a criterion cites, or whether
 * a document is approved — because a renderer that reasons about documents is a second
 * implementation of the document rules, and the two will disagree.
 *
 * So the projection sits between them. It reads the snapshot the caller selected — the
 * working version or an archived one, whichever was asked for — and produces columns,
 * rows and blocks. The snapshot is the authority; this is a view of it.
 *
 * Two shapes, because there are two kinds of output. Structured formats want a table with
 * typed cells. Human-readable formats want a document: headings, paragraphs, lists and
 * the occasional table, in reading order.
 */

/** A cell's type, so a spreadsheet stores hours as hours and ids as text. */
export type CellValue =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  /** Only when the document holds a real, authoritative date. */
  | { readonly kind: 'date'; readonly value: Date }
  | { readonly kind: 'empty' };

export const text = (value: string | undefined): CellValue =>
  value === undefined || value === '' ? { kind: 'empty' } : { kind: 'text', value };

export const number = (value: number | undefined): CellValue =>
  value === undefined ? { kind: 'empty' } : { kind: 'number', value };

/** A list of ids or labels, joined deterministically rather than as `[object Object]`. */
export const list = (values: readonly string[] | undefined): CellValue =>
  !values || values.length === 0 ? { kind: 'empty' } : { kind: 'text', value: values.join('; ') };

export const flag = (value: boolean | undefined): CellValue =>
  value === undefined ? { kind: 'empty' } : { kind: 'text', value: value ? 'Yes' : 'No' };

export interface TableColumn {
  readonly header: string;
  /** A hint for column width in spreadsheets. Presentation only. */
  readonly width?: number;
}

/** The structured projection: what CSV and XLSX render. */
export interface TableProjection {
  readonly sheetName: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly (readonly CellValue[])[];
}

/** The reading-order projection: what DOCX and PDF render. */
export type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  /** A caption above a table, and the table itself. */
  | {
      readonly kind: 'table';
      readonly caption?: string;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
      /** Wide tables ask for landscape rather than an unreadable squeeze. */
      readonly wide?: boolean;
    }
  /** An honest empty section, with the reason it is empty. */
  | { readonly kind: 'note'; readonly text: string };

export interface ProseProjection {
  readonly blocks: readonly Block[];
  /** Whether the document as a whole reads better on its side. */
  readonly landscape: boolean;
}

/**
 * What a file says about itself.
 *
 * A file outlives the screen it came from, so it carries its own version, what had been
 * decided about it and whether its inputs have moved since. `exportedAt` is the moment the
 * file was made and nothing else — not a start date, not an approval, not a deadline.
 * Those come from the document when the document has them.
 */
export function exportMetadata(input: {
  readonly snapshot: DocumentSnapshot;
  readonly document: ProjectDocument;
  readonly projectName: string;
  readonly branding: Branding | undefined;
  readonly exportedAt: Date;
}): ExportMetadata {
  const { snapshot, branding } = input;

  return {
    projectName: input.projectName,
    documentLabel: PROJECT_DOCUMENT_LABELS[input.document],
    documentVersion: snapshot.version,
    statusLabel: DOCUMENT_STATUS_LABELS[snapshot.status],
    outdated: snapshot.currentness === 'OUTDATED',
    outdatedReasons: snapshot.outdatedReasons.map((reason) => reason.summary),
    exportedAt: input.exportedAt.toISOString(),
    ...(branding?.organizationName ? { organizationName: branding.organizationName } : {}),
    ...(branding?.footerText ? { footerText: branding.footerText } : {}),
  };
}

/**
 * The status block that opens a human-readable export.
 *
 * Stated plainly rather than stamped across the page. A client document with a watermark
 * over the text is a document nobody can use; a document that quietly omits being three
 * versions out of date is worse. A short block at the top says both.
 */
export function metadataBlocks(metadata: ExportMetadata): readonly Block[] {
  const lines = [
    `${metadata.documentLabel} — version ${metadata.documentVersion}`,
    `Status: ${metadata.statusLabel}`,
  ];

  if (metadata.outdated) {
    lines.push(
      'This version was written against inputs that have since changed. It is reproduced as it stands.',
    );
  }

  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: metadata.projectName },
    { kind: 'heading', level: 2, text: metadata.documentLabel },
    { kind: 'bullets', items: lines },
  ];

  if (metadata.outdated && metadata.outdatedReasons.length > 0) {
    blocks.push({
      kind: 'bullets',
      items: metadata.outdatedReasons.map((reason) => `Since this version: ${reason}`),
    });
  }

  return blocks;
}

/** Rows of a generic-row document, in stored order, payload-typed by the caller. */
export function rowPayloads<T>(snapshot: DocumentSnapshot, kind: string): readonly T[] {
  return snapshot.rows.filter((row) => row.kind === kind).map((row) => row.payload as unknown as T);
}
