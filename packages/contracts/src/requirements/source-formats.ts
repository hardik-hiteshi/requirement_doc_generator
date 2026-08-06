import { z } from 'zod';

/**
 * What the ingestion pipeline accepts, and how it decides.
 *
 * Three independent signals have to agree before a file is processed: the
 * extension, the MIME type the browser declared, and the file's own leading
 * bytes. Any one of them alone is a claim by the uploader; together they are
 * evidence. A `.pdf` that starts with `MZ` is not a PDF, whatever the browser
 * said about it.
 */

export const SUPPORTED_EXTENSIONS = [
  'pdf',
  'docx',
  'txt',
  'csv',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'webp',
] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

/**
 * Formats accepted only through the legacy-conversion boundary.
 *
 * Listed separately, and deliberately not in `SUPPORTED_EXTENSIONS`, so nothing
 * can treat them as natively readable. Whether they are actually accepted
 * depends on whether a converter is configured — see `LEGACY_CONVERSION`.
 */
export const LEGACY_EXTENSIONS = ['doc', 'xls'] as const;

export type LegacyExtension = (typeof LEGACY_EXTENSIONS)[number];

export type IngestibleExtension = SupportedExtension | LegacyExtension;

/** Content types the browser may legitimately declare, per extension. */
export const ALLOWED_MIME_TYPES: Readonly<Record<IngestibleExtension, readonly string[]>> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  txt: ['text/plain'],
  // Browsers and spreadsheet tools disagree about CSV; all four are seen in the
  // wild for the same file, so the signature check is what actually decides.
  csv: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp'],
  doc: ['application/msword'],
  xls: ['application/vnd.ms-excel'],
};

/**
 * Leading-byte signatures, as hex.
 *
 * `null` means the format has no reliable magic number — plain text and CSV are
 * defined by what they are *not*, so they are validated by decodability instead
 * (see the API's content sniffing). Pretending otherwise would let a byte
 * pattern stand in for a check that never happened.
 */
export const FILE_SIGNATURES: Readonly<Record<IngestibleExtension, readonly string[] | null>> = {
  pdf: ['25504446'], // %PDF
  docx: ['504b0304', '504b0506', '504b0708'], // ZIP container
  xlsx: ['504b0304', '504b0506', '504b0708'], // ZIP container
  png: ['89504e470d0a1a0a'],
  jpg: ['ffd8ff'],
  jpeg: ['ffd8ff'],
  webp: ['52494646'], // RIFF; the WEBP tag at offset 8 is checked separately
  doc: ['d0cf11e0a1b11ae1'], // OLE2 compound file
  xls: ['d0cf11e0a1b11ae1'], // OLE2 compound file
  txt: null,
  csv: null,
};

/** Formats whose bytes are a ZIP container, so decompression limits apply. */
export const ZIP_CONTAINER_EXTENSIONS: readonly IngestibleExtension[] = ['docx', 'xlsx'];

/** Formats that can only be read by optical character recognition. */
export const IMAGE_EXTENSIONS: readonly SupportedExtension[] = ['png', 'jpg', 'jpeg', 'webp'];

export function isSupportedExtension(value: string): value is SupportedExtension {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(value);
}

export function isLegacyExtension(value: string): value is LegacyExtension {
  return (LEGACY_EXTENSIONS as readonly string[]).includes(value);
}

export function isImageExtension(value: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(value);
}

/** The `accept` attribute for the file picker. Convenience, never a control. */
export const FILE_PICKER_ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/**
 * Legacy-format policy, stated once.
 *
 * Conversion is defined as a boundary and left unconfigured by default. A
 * converter is a large external binary, and shipping one nobody asked for is not
 * a decision this phase should make on a deployment's behalf. Where it is not
 * configured, `.doc` and `.xls` are rejected with an explanation — never
 * silently, and never with a claim of support that is not there.
 */
export const LEGACY_CONVERSION = {
  extensions: LEGACY_EXTENSIONS,
  /** Shown when a legacy file arrives and no converter is configured. */
  unavailableMessage:
    'Legacy .doc and .xls files need conversion, which is not enabled on this deployment. Save the file as .docx or .xlsx and upload it again.',
} as const;

export const sourceKindSchema = z.enum(['PASTED_TEXT', 'FILE']);
export type SourceKind = z.infer<typeof sourceKindSchema>;
