import { FILE_SIGNATURES, isImageExtension, type IngestibleExtension } from '@wdrg/contracts';

/**
 * Deciding what a file actually is, from its bytes.
 *
 * A browser's `Content-Type` and a filename's extension are both claims made by
 * whoever uploaded the file. The leading bytes are not. Everything here works
 * from those bytes and nothing else, which is why the result can be trusted to
 * contradict the other two.
 *
 * Detection is deliberately written by hand rather than delegated to a library.
 * The set of formats is small, closed and defined in the shared contract; a
 * dependency would add a supply-chain surface and a moving definition of
 * "supported" in exchange for identifying hundreds of formats this application
 * refuses anyway.
 */

export type SignatureVerdict =
  /** The bytes match the extension's signature. */
  | 'match'
  /** The bytes match a *different* known format. */
  | 'mismatch'
  /** The format has no signature (text, CSV); decodability was checked instead. */
  | 'no_signature'
  /** Nothing recognisable, and the format expects a signature. */
  | 'unrecognised';

export interface SignatureResult {
  readonly verdict: SignatureVerdict;
  /** MIME type implied by the bytes, when they were recognised. */
  readonly detectedMimeType?: string;
  /** Which known format the bytes look like, when it is not the declared one. */
  readonly detectedExtension?: string;
}

/** How many leading bytes any check needs. */
export const SIGNATURE_SAMPLE_BYTES = 32;

const SIGNATURE_MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ole2: 'application/x-ole-storage',
  gif: 'image/gif',
  elf: 'application/x-executable',
  exe: 'application/vnd.microsoft.portable-executable',
  rar: 'application/vnd.rar',
  gzip: 'application/gzip',
  sevenzip: 'application/x-7z-compressed',
};

/**
 * Signatures we can name, including several nothing here accepts.
 *
 * Recognising a rejected format is not wasted work: telling a user "this is a
 * Windows executable, not a PDF" is a far better answer than "unrecognised
 * file", and it is the difference between a mistake they can fix and a mystery.
 */
const KNOWN_SIGNATURES: readonly { readonly id: string; readonly hex: string }[] = [
  { id: 'pdf', hex: '25504446' },
  { id: 'png', hex: '89504e470d0a1a0a' },
  { id: 'jpg', hex: 'ffd8ff' },
  { id: 'gif', hex: '474946383761' },
  { id: 'gif', hex: '474946383961' },
  { id: 'webp', hex: '52494646' },
  { id: 'zip', hex: '504b0304' },
  { id: 'zip', hex: '504b0506' },
  { id: 'zip', hex: '504b0708' },
  { id: 'ole2', hex: 'd0cf11e0a1b11ae1' },
  { id: 'elf', hex: '7f454c46' },
  { id: 'exe', hex: '4d5a' },
  { id: 'rar', hex: '526172211a07' },
  { id: 'gzip', hex: '1f8b' },
  { id: 'sevenzip', hex: '377abcaf271c' },
];

function leadingHex(content: Buffer, bytes = SIGNATURE_SAMPLE_BYTES): string {
  return content.subarray(0, bytes).toString('hex').toLowerCase();
}

/** The format the bytes look like, or `undefined` if nothing matches. */
export function detectSignature(content: Buffer): string | undefined {
  const hex = leadingHex(content);

  // Longest first: `504b0304` and `504b0506` share a prefix, and RIFF-based
  // formats are only distinguishable further in.
  const ordered = [...KNOWN_SIGNATURES].sort((a, b) => b.hex.length - a.hex.length);
  const found = ordered.find((signature) => hex.startsWith(signature.hex));

  if (found?.id === 'webp') {
    // RIFF alone is a container. WEBP is RIFF with `WEBP` at offset 8, and
    // without that check a WAV file would pass as an image.
    return content.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : undefined;
  }

  return found?.id;
}

/**
 * Whether a buffer decodes as text.
 *
 * TXT and CSV have no signature, so this is what stands in for one: a NUL byte
 * or a run of invalid UTF-8 means the file is binary regardless of what it is
 * called. It is a weaker check than a magic number, and it is described that way
 * rather than dressed up as detection.
 */
export function looksLikeText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8_192));

  if (sample.includes(0)) {
    return false;
  }

  // A UTF-8 decode of valid bytes never produces U+FFFD; a handful can appear
  // legitimately in text that already contained one, so allow a small margin.
  const decoded = sample.toString('utf8');
  const replacements = (decoded.match(/\uFFFD/g) ?? []).length;

  return replacements <= Math.max(1, Math.floor(decoded.length / 1_000));
}

/**
 * Checks the bytes against what the extension claims.
 *
 * Returns a verdict rather than a boolean, because "these bytes are a Windows
 * executable" and "these bytes are not recognisable at all" call for different
 * messages and different levels of concern.
 */
export function verifySignature(extension: IngestibleExtension, content: Buffer): SignatureResult {
  const expected = FILE_SIGNATURES[extension];

  if (expected === null) {
    // No signature to check. Fall back to decodability, and say so.
    if (looksLikeText(content)) {
      return { verdict: 'no_signature', detectedMimeType: 'text/plain' };
    }

    const detected = detectSignature(content);

    return {
      verdict: 'mismatch',
      ...(detected ? { detectedExtension: detected } : {}),
      detectedMimeType: detected ? SIGNATURE_MIME_TYPES[detected] : 'application/octet-stream',
    };
  }

  const hex = leadingHex(content);
  const matches = expected.some((signature) => hex.startsWith(signature));

  if (matches) {
    // A ZIP container is shared by DOCX and XLSX, so the prefix alone does not
    // distinguish them; which one it is comes from opening it, later.
    if (extension === 'webp' && content.subarray(8, 12).toString('ascii') !== 'WEBP') {
      return { verdict: 'mismatch', detectedExtension: 'riff' };
    }

    return { verdict: 'match', detectedMimeType: mimeTypeFor(extension) };
  }

  const detected = detectSignature(content);

  return detected
    ? {
        verdict: 'mismatch',
        detectedExtension: detected,
        detectedMimeType: SIGNATURE_MIME_TYPES[detected],
      }
    : { verdict: 'unrecognised' };
}

function mimeTypeFor(extension: IngestibleExtension): string {
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'doc':
      return 'application/msword';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'csv':
      return 'text/csv';
    case 'txt':
      return 'text/plain';
  }
}

/**
 * Whether a PDF is encrypted, from its trailer.
 *
 * A cheap pre-check so an encrypted file is refused before a parser is handed
 * something it will only fail on. The extractor's own password detection is the
 * authority; this exists to reach the right error sooner and with less work.
 */
export function looksEncryptedPdf(content: Buffer): boolean {
  // The trailer is at the end; scanning the tail avoids reading a large file in
  // full just to answer this.
  const tail = content.subarray(Math.max(0, content.length - 4_096)).toString('latin1');
  return /\/Encrypt\s/.test(tail) || /\/Encrypt\d*\s+\d+\s+R/.test(tail);
}

/** True for a format only OCR can read. */
export function requiresOcr(extension: string): boolean {
  return isImageExtension(extension);
}
