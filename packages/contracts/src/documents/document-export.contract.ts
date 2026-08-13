import { z } from 'zod';

import {
  ALLOWED_FORMATS,
  EXPORT_FORMATS,
  isFormatAllowed,
  PROJECT_DOCUMENT_LABELS,
  type ExportFormat,
  type ProjectDocument,
} from '../project/output-preferences.contract';

/**
 * Turning a stored document version into a file somebody can send.
 *
 * The matrix of what can be exported in what already exists: `ALLOWED_FORMATS` in the
 * output-preferences contract, where it was written down a phase before anything could
 * render. It stays the single authority — this module asks it rather than restating it,
 * because two lists of supported formats is one list and one bug.
 *
 * Export is read-derived throughout. Nothing here creates a version, moves a lifecycle
 * or reconciles currentness; the selected snapshot is rendered as it stands, including
 * when it stands out of date.
 */

export const EXPORT_MIME_TYPES: Readonly<Record<ExportFormat, string>> = {
  CSV: 'text/csv; charset=utf-8',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf',
};

export const EXPORT_EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  CSV: 'csv',
  XLSX: 'xlsx',
  DOCX: 'docx',
  PDF: 'pdf',
};

/** Formats offered for a document. Asks the matrix; never a second copy of it. */
export function exportFormatsFor(document: ProjectDocument): readonly ExportFormat[] {
  return ALLOWED_FORMATS[document];
}

export const EXPORT_ERROR_CODES = {
  /** The document/format pair is not in the matrix. */
  UNSUPPORTED_EXPORT_FORMAT: 'UNSUPPORTED_EXPORT_FORMAT',
  /** Nothing has been written yet, so there is no version to render. */
  DOCUMENT_NOT_GENERATED: 'DOCUMENT_NOT_GENERATED',
  /** A version number that does not exist for this document. */
  EXPORT_VERSION_NOT_FOUND: 'EXPORT_VERSION_NOT_FOUND',
  /** The renderer could not produce the file. The document is untouched. */
  EXPORT_RENDER_FAILED: 'EXPORT_RENDER_FAILED',
  /** Branding is stored but unusable — an unreadable logo, for instance. */
  EXPORT_BRANDING_INVALID: 'EXPORT_BRANDING_INVALID',
  /** The rendered file exceeded the renderer's output limit. */
  EXPORT_TOO_LARGE: 'EXPORT_TOO_LARGE',
  /** Content that must never leave the building was found on the way out. */
  EXPORT_CONTENT_REFUSED: 'EXPORT_CONTENT_REFUSED',
} as const;

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[keyof typeof EXPORT_ERROR_CODES];

/**
 * What the caller may choose.
 *
 * Three things and no more: which document, which format, which version. Everything else
 * about an export — the project, the lifecycle status, the authority it was composed
 * against, where the file is written — is server-derived. A caller that can name a
 * storage key or a project id is a caller that can read somebody else's document.
 */
export const exportRequestSchema = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    /** Omitted means the working version. */
    version: z.number().int().positive().optional(),
  })
  .strict();

export type ExportRequest = z.infer<typeof exportRequestSchema>;

/**
 * A filename a filesystem cannot misread.
 *
 * Built from the project name, the document and the version, then reduced to a
 * conservative alphabet. Path separators, traversal, control characters, leading dots and
 * Windows' reserved trailing dot or space all disappear here rather than in whatever
 * shell, archive tool or download directory the file reaches later. Nothing the caller
 * sends is ever used as a path.
 */
export function exportFilename(input: {
  readonly projectName: string;
  readonly document: ProjectDocument;
  readonly format: ExportFormat;
  readonly version: number;
  readonly lifecycleLabel?: string;
}): string {
  const slug = (value: string): string =>
    value
      .normalize('NFKD')
      /* Anything that is not plainly a letter, digit or space becomes a space. */
      .replace(/[^\p{Letter}\p{Number} ]+/gu, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60);

  const project = slug(input.projectName) || 'project';
  const document = slug(PROJECT_DOCUMENT_LABELS[input.document]);
  const lifecycle = input.lifecycleLabel ? `_${slug(input.lifecycleLabel)}` : '';
  const name = `${project}_${document}_v${input.version}${lifecycle}`;

  return `${name}.${EXPORT_EXTENSIONS[input.format]}`;
}

/**
 * A `Content-Disposition` value that cannot carry anything but a filename.
 *
 * The name is already reduced to letters, digits and hyphens by `exportFilename`, so
 * there is no quote or newline left to break the header with. Asserted rather than
 * escaped: escaping here would suggest the input might still be hostile, and the point is
 * that it cannot be.
 */
export function contentDisposition(filename: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new Error(`Refusing to send a filename with unexpected characters: ${filename}`);
  }

  return `attachment; filename="${filename}"`;
}

/**
 * The status block a human-readable export carries.
 *
 * A file that leaves the building outlives the screen it was generated from, so it has to
 * say what it is: which version, what had been decided about it, and whether what it was
 * built on has moved since. `exportedAt` is when the file was made — never confused with
 * a project start date, an approval date or a deadline, which come from the document.
 */
export const exportMetadataSchema = z
  .object({
    projectName: z.string(),
    documentLabel: z.string(),
    documentVersion: z.number().int().positive(),
    statusLabel: z.string(),
    outdated: z.boolean(),
    /** Why it is out of date, in the user's words. Empty when it is current. */
    outdatedReasons: z.array(z.string()).max(20),
    exportedAt: z.string(),
    organizationName: z.string().optional(),
    footerText: z.string().optional(),
  })
  .strict();

export type ExportMetadata = z.infer<typeof exportMetadataSchema>;

/** Whether this pair may be exported at all. The matrix decides. */
export function assertExportable(document: ProjectDocument, format: ExportFormat): void {
  if (!isFormatAllowed(document, format)) {
    throw new Error(
      `${format} is not available for ${PROJECT_DOCUMENT_LABELS[document]}. Allowed: ${ALLOWED_FORMATS[
        document
      ].join(', ')}.`,
    );
  }
}
