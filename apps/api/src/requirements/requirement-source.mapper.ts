import {
  countLowConfidenceBlocks,
  extractedContentSchema,
  type ContentRevision,
  type ExtractedContent,
  type RequirementSource,
  type RequirementSourceSummary,
  type SourceFile,
} from '@wdrg/contracts';

import type { ExtractedContentDocument } from './schemas/extracted-content.schema';
import type { RequirementSourceDocument } from './schemas/requirement-source.schema';

/**
 * Persistence to response, field by field.
 *
 * Spreading a Mongoose document into a response would work today and would leak
 * the next field somebody adds — `storageObjectId` being the one that matters
 * most here, since it is an internal address that no client has any use for.
 * Listing the fields means a new one is invisible until somebody decides it
 * should be visible.
 */

export function toSourceFile(document: RequirementSourceDocument): SourceFile | undefined {
  if (document.kind !== 'FILE' || !document.originalFilename) {
    return undefined;
  }

  return {
    originalFilename: document.originalFilename,
    displayFilename: document.displayFilename ?? document.originalFilename,
    extension: document.extension ?? '',
    declaredMimeType: document.declaredMimeType ?? 'application/octet-stream',
    ...(document.detectedMimeType ? { detectedMimeType: document.detectedMimeType } : {}),
    sizeBytes: document.sizeBytes ?? 0,
    checksumSha256: document.checksumSha256 ?? '',
    validationResult: (document.validationResult ?? 'PENDING') as SourceFile['validationResult'],
    malwareScanResult: (document.malwareScanResult ??
      'NOT_SCANNED') as SourceFile['malwareScanResult'],
    ...(document.duplicateOf ? { duplicateOf: document.duplicateOf } : {}),
    ...(document.convertedFrom ? { convertedFrom: document.convertedFrom } : {}),
  };
}

export function toSourceSummary(document: RequirementSourceDocument): RequirementSourceSummary {
  const file = toSourceFile(document);

  return {
    sourceId: document.sourceId,
    kind: document.kind,
    status: document.status,
    title: document.title,
    version: document.version,
    reviewStatus: document.reviewStatus,
    ...(document.reviewedAt ? { reviewedAt: document.reviewedAt.toISOString() } : {}),
    ...(file ? { file } : {}),
    currentRevision: document.currentRevision,
    ...(document.failureCode ? { failureCode: document.failureCode } : {}),
    ...(document.failureMessage ? { failureMessage: document.failureMessage } : {}),
    retryCount: document.retryCount,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    ...(document.deletedAt ? { deletedAt: document.deletedAt.toISOString() } : {}),
    // The text itself is not in a summary — a list of ten pasted briefs would
    // otherwise ship a megabyte to render ten rows.
    ...(document.text !== undefined ? { textLength: document.text.length } : {}),
    ...(document.blockCount !== undefined ? { blockCount: document.blockCount } : {}),
    ...(document.warningCount !== undefined ? { warningCount: document.warningCount } : {}),
    ...(document.lowConfidenceBlockCount !== undefined
      ? { lowConfidenceBlockCount: document.lowConfidenceBlockCount }
      : {}),
  };
}

export function toContentRevision(document: ExtractedContentDocument): ContentRevision {
  return {
    revision: document.revision,
    origin: document.origin,
    createdAt: document.createdAt.toISOString(),
    changedBlockIds: document.changedBlockIds,
    ...(document.note ? { note: document.note } : {}),
  };
}

/**
 * A stored revision, re-parsed against the published contract.
 *
 * Not a formality. These documents were written by an extractor that may have
 * been a different version of this code, and a response that does not satisfy
 * the contract is a bug the client will hit rather than one the server catches.
 */
export function toExtractedContent(document: ExtractedContentDocument): ExtractedContent {
  return extractedContentSchema.parse({
    blocks: document.blocks,
    warnings: document.warnings,
    minimumConfidence: document.minimumConfidence,
    ...(document.pageCount !== undefined ? { pageCount: document.pageCount } : {}),
    ...(document.sheetNames ? { sheetNames: document.sheetNames } : {}),
    usedOcr: document.usedOcr,
    extractedAt: document.createdAt.toISOString(),
    extractor: document.extractor,
  });
}

export function toFullSource(
  document: RequirementSourceDocument,
  options: {
    effective?: ExtractedContent;
    original?: ExtractedContent;
    revisions: ContentRevision[];
  },
): RequirementSource {
  const file = toSourceFile(document);

  return {
    sourceId: document.sourceId,
    kind: document.kind,
    status: document.status,
    title: document.title,
    version: document.version,
    reviewStatus: document.reviewStatus,
    ...(document.reviewedAt ? { reviewedAt: document.reviewedAt.toISOString() } : {}),
    ...(document.text !== undefined ? { text: document.text } : {}),
    ...(file ? { file } : {}),
    ...(options.effective ? { effectiveContent: options.effective } : {}),
    ...(options.original ? { originalContent: options.original } : {}),
    currentRevision: document.currentRevision,
    revisions: options.revisions,
    ...(document.failureCode ? { failureCode: document.failureCode } : {}),
    ...(document.failureMessage ? { failureMessage: document.failureMessage } : {}),
    retryCount: document.retryCount,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    ...(document.deletedAt ? { deletedAt: document.deletedAt.toISOString() } : {}),
  };
}

/** The counters a list needs, derived once when content is written. */
export function contentCounters(content: ExtractedContent): {
  blockCount: number;
  warningCount: number;
  lowConfidenceBlockCount: number;
  minimumConfidence: number;
  usedOcr: boolean;
} {
  return {
    blockCount: content.blocks.length,
    warningCount: content.warnings.length,
    lowConfidenceBlockCount: countLowConfidenceBlocks(content),
    minimumConfidence: content.minimumConfidence,
    usedOcr: content.usedOcr,
  };
}
