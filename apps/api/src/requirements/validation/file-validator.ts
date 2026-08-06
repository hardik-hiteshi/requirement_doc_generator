import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  ALLOWED_MIME_TYPES,
  isLegacyExtension,
  isSupportedExtension,
  REQUIREMENT_ERROR_CODES,
  ZIP_CONTAINER_EXTENSIONS,
  type IngestibleExtension,
  type RequirementErrorCode,
} from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import { looksEncryptedPdf, verifySignature } from './content-signature';
import { hasMultipleExtensions, normalizeFilename } from './filename';
import { inspectZipContainer } from './zip-safety';

/**
 * The gate every uploaded file passes before anything else touches it.
 *
 * The checks run cheapest-first, and each one is allowed to end the process. A
 * file that fails is never written to storage, never queued and never opened by
 * a parser — which is the point: the expensive, attackable operations happen
 * only to files that have already been shown to be what they claim.
 *
 * Order matters and is not arbitrary:
 *
 *  1. **Filename** — before anything is stored under it or logged with it.
 *  2. **Size** — before the bytes are hashed or scanned.
 *  3. **Extension** — before a parser is chosen.
 *  4. **Declared MIME** — the browser's claim, checked against the extension.
 *  5. **Signature** — the bytes themselves, which can overrule both.
 *  6. **Container safety** — for ZIP formats, before anything decompresses.
 *  7. **Encryption** — before a parser is handed something it cannot open.
 *  8. **Checksum** — last, because it is the only step that reads every byte.
 */

export interface FileCandidate {
  readonly originalFilename: string;
  readonly declaredMimeType: string;
  readonly content: Buffer;
}

export interface ValidationRejection {
  readonly code: RequirementErrorCode;
  /** Operator-facing detail. Logged, never returned to the caller. */
  readonly detail: string;
}

export interface ValidatedFile {
  readonly displayFilename: string;
  readonly extension: IngestibleExtension;
  readonly declaredMimeType: string;
  readonly detectedMimeType?: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  /** True when the file needs conversion before any extractor can read it. */
  readonly requiresLegacyConversion: boolean;
  /** Non-fatal observations worth recording against the source. */
  readonly notes: readonly string[];
}

export type ValidationOutcome =
  | { readonly ok: true; readonly file: ValidatedFile }
  | { readonly ok: false; readonly rejection: ValidationRejection };

@Injectable()
export class FileValidator {
  constructor(private readonly config: AppConfigService) {}

  validate(candidate: FileCandidate): ValidationOutcome {
    const limits = this.config.upload;
    const notes: string[] = [];

    /* 1. Filename. */
    const filename = normalizeFilename(candidate.originalFilename, limits.maxFilenameLength);

    if (!filename.ok) {
      return reject(
        filename.rejection === 'too_long'
          ? REQUIREMENT_ERROR_CODES.UNSAFE_FILENAME
          : REQUIREMENT_ERROR_CODES.UNSAFE_FILENAME,
        `filename rejected: ${filename.rejection ?? 'unknown'}`,
      );
    }

    // A double extension is not itself grounds for refusal — `report.v2.pdf` is
    // ordinary — but it is worth recording, because the last extension is the
    // one that decides and a user may have meant the first.
    if (hasMultipleExtensions(filename.display)) {
      notes.push('multiple_extensions');
    }

    /* 2. Size. */
    if (candidate.content.length === 0) {
      return reject(REQUIREMENT_ERROR_CODES.FILE_EMPTY, 'zero bytes');
    }

    if (candidate.content.length > limits.maxFileBytes) {
      return reject(
        REQUIREMENT_ERROR_CODES.FILE_TOO_LARGE,
        `${candidate.content.length} bytes exceeds ${limits.maxFileBytes}`,
      );
    }

    /* 3. Extension. */
    const extension = filename.extension;
    const legacy = isLegacyExtension(extension);

    if (!isSupportedExtension(extension) && !legacy) {
      return reject(REQUIREMENT_ERROR_CODES.UNSUPPORTED_FORMAT, `extension "${extension}"`);
    }

    if (legacy && !this.config.legacyConversion.enabled) {
      return reject(
        REQUIREMENT_ERROR_CODES.LEGACY_FORMAT_UNAVAILABLE,
        `legacy extension "${extension}" with conversion disabled`,
      );
    }

    const ingestible: IngestibleExtension = extension;

    /* 4. Declared MIME type. */
    const allowed = ALLOWED_MIME_TYPES[ingestible];
    const declared = candidate.declaredMimeType.split(';')[0]?.trim().toLowerCase() ?? '';

    if (!allowed.includes(declared)) {
      // `application/octet-stream` is what a browser sends when it has no idea,
      // which is common for CSV and for files dragged from unusual sources. The
      // signature check below is the real gate, so this is a note, not a refusal.
      if (declared === 'application/octet-stream' || declared === '') {
        notes.push('mime_unspecified');
      } else {
        return reject(
          REQUIREMENT_ERROR_CODES.MIME_MISMATCH,
          `declared "${declared}" not allowed for ".${extension}"`,
        );
      }
    }

    /* 5. Signature. */
    const signature = verifySignature(ingestible, candidate.content);

    if (signature.verdict === 'mismatch' || signature.verdict === 'unrecognised') {
      return reject(
        REQUIREMENT_ERROR_CODES.SIGNATURE_MISMATCH,
        `.${extension} bytes look like ${signature.detectedExtension ?? 'nothing recognised'}`,
      );
    }

    if (signature.verdict === 'no_signature') {
      notes.push('validated_by_decodability');
    }

    /* 6. ZIP containers, before anything decompresses. */
    if ((ZIP_CONTAINER_EXTENSIONS as readonly string[]).includes(extension)) {
      const container = inspectZipContainer(
        candidate.content,
        this.config.extraction.maxUncompressedBytes,
      );

      if (!container.ok) {
        return reject(
          container.reason === 'encrypted'
            ? REQUIREMENT_ERROR_CODES.PASSWORD_PROTECTED
            : container.reason === 'expansion_limit'
              ? REQUIREMENT_ERROR_CODES.ARCHIVE_LIMIT_EXCEEDED
              : REQUIREMENT_ERROR_CODES.CORRUPTED_FILE,
          `zip container: ${container.reason}`,
        );
      }
    }

    /* 7. Encryption, for PDFs. */
    if (extension === 'pdf' && looksEncryptedPdf(candidate.content)) {
      return reject(REQUIREMENT_ERROR_CODES.PASSWORD_PROTECTED, 'pdf trailer declares /Encrypt');
    }

    /* 8. Checksum — the only pass over the whole buffer. */
    const checksumSha256 = createHash('sha256').update(candidate.content).digest('hex');

    return {
      ok: true,
      file: {
        displayFilename: filename.display,
        extension: ingestible,
        declaredMimeType: declared || 'application/octet-stream',
        ...(signature.detectedMimeType ? { detectedMimeType: signature.detectedMimeType } : {}),
        sizeBytes: candidate.content.length,
        checksumSha256,
        requiresLegacyConversion: legacy,
        notes,
      },
    };
  }
}

function reject(code: RequirementErrorCode, detail: string): ValidationOutcome {
  return { ok: false, rejection: { code, detail } };
}

/** SHA-256 of arbitrary content. Used for pasted text as well as files. */
export function checksumOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
