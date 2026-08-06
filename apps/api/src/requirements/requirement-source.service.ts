import type { Readable } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  API_ERROR_CODES,
  canTransitionSource,
  detectInjectionSignals,
  hasExtractedContent,
  isRetryable,
  REQUIREMENT_ERROR_CODES,
  requirementErrorMessage,
  type AddTextSourceRequest,
  type ContentRevision,
  type CorrectContentRequest,
  type ExtractedContent,
  type RequirementErrorCode,
  type RequirementSource,
  type SourceListResponse,
  type UpdateTextSourceRequest,
  type UploadOutcome,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { AppException, ValidationFailedException } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { FILE_STORAGE_PORT, type FileStoragePort } from '../ports';
import { ExtractionQueue } from './queue/extraction.queue';
import { LocalFileStorageAdapter } from './storage/local-file-storage.adapter';
import {
  contentCounters,
  toContentRevision,
  toExtractedContent,
  toFullSource,
  toSourceSummary,
} from './requirement-source.mapper';
import { RequirementSourceRepository } from './requirement-source.repository';
import { FileValidator, type FileCandidate } from './validation/file-validator';

export interface SourceContext {
  readonly projectId: string;
  readonly correlationId: string;
}

/**
 * Requirement sources, from arrival to review.
 *
 * The ordering rule that runs through every method here: **nothing is stored
 * until it has been validated, and nothing is queued until it has been stored.**
 * A file that fails validation never reaches the disk, and a file that fails to
 * store never becomes a job pointing at bytes that are not there.
 */
@Injectable()
export class RequirementSourceService {
  private readonly logger = new Logger(RequirementSourceService.name);

  constructor(
    private readonly repository: RequirementSourceRepository,
    private readonly validator: FileValidator,
    private readonly queue: ExtractionQueue,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE_PORT) private readonly storage: FileStoragePort,
  ) {}

  /* ------------------------------------------------------------------ list */

  async list(context: SourceContext): Promise<SourceListResponse> {
    const [documents, usage] = await Promise.all([
      this.repository.listForProject(context.projectId),
      this.repository.usage(context.projectId),
    ]);

    const limits = this.config.upload;

    return {
      sources: documents.map(toSourceSummary),
      usage: {
        fileCount: usage.fileCount,
        totalBytes: usage.totalBytes,
        maxFiles: limits.maxFilesPerProject,
        maxTotalBytes: limits.maxProjectBytes,
        maxFileBytes: limits.maxFileBytes,
      },
    };
  }

  /* ----------------------------------------------------------- pasted text */

  async addTextSource(
    request: AddTextSourceRequest,
    context: SourceContext,
  ): Promise<RequirementSource> {
    const sourceId = RequirementSourceRepository.newSourceId();
    const signals = detectInjectionSignals(request.text);

    await this.repository.create({
      sourceId,
      projectId: context.projectId,
      kind: 'PASTED_TEXT',
      // Pasted text needs no extraction pass — it is already text — so it goes
      // straight to review. Pretending it went through a pipeline would show the
      // user a progress bar for work that is not happening.
      status: 'REVIEW_REQUIRED',
      title: request.title,
      text: request.text,
      version: 0,
      reviewStatus: 'NOT_REVIEWED',
      currentRevision: 0,
      revisionCount: 1,
      retryCount: 0,
      ...(signals.length > 0 ? { injectionSignals: signals.map((signal) => signal.id) } : {}),
    });

    const content = textToContent(request.text);
    await this.repository.appendRevision(context.projectId, sourceId, 0, 'EXTRACTION', content);

    await this.repository.setStatus(sourceId, 'REVIEW_REQUIRED', contentCounters(content));

    await this.audit.record({
      type: 'REQUIREMENT_TEXT_ADDED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      // Length and signal ids only. The text itself is requirement evidence and
      // has no business in an audit document.
      metadata: { sourceId, textLength: request.text.length, injectionSignals: signals.length },
    });

    return this.readSource(context, sourceId);
  }

  async updateTextSource(
    sourceId: string,
    request: UpdateTextSourceRequest,
    context: SourceContext,
  ): Promise<RequirementSource> {
    const existing = await this.requireSource(context, sourceId);

    if (existing.kind !== 'PASTED_TEXT') {
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    const signals = detectInjectionSignals(request.text);
    const content = textToContent(request.text);
    const nextRevision = existing.revisionCount;

    const updated = await this.repository.updateWithVersion(
      context.projectId,
      sourceId,
      request.version,
      {
        title: request.title,
        text: request.text,
        // An edit invalidates a previous review: the reviewer approved different
        // words. Silently keeping REVIEWED would let edited text inherit an
        // approval nobody gave it.
        status: 'REVIEW_REQUIRED',
        reviewStatus: 'NOT_REVIEWED',
        currentRevision: nextRevision,
        revisionCount: nextRevision + 1,
        ...contentCounters(content),
        ...(signals.length > 0 ? { injectionSignals: signals.map((signal) => signal.id) } : {}),
      },
      { reviewedAt: '' },
    );

    if (!updated) {
      throw this.versionConflict(request.version);
    }

    await this.repository.appendRevision(
      context.projectId,
      sourceId,
      nextRevision,
      'CORRECTION',
      content,
      [],
      'Requirement text edited',
    );

    await this.audit.record({
      type: 'REQUIREMENT_TEXT_UPDATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, textLength: request.text.length },
    });

    return this.readSource(context, sourceId);
  }

  /* ---------------------------------------------------------------- upload */

  /**
   * Accepts a batch of files, reporting each independently.
   *
   * One bad file in a drag-and-drop of ten must not reject the other nine. Every
   * outcome — accepted, duplicate, rejected and why — is returned per file, so
   * the UI can show a row per file rather than one error for the batch.
   */
  async uploadFiles(
    candidates: readonly FileCandidate[],
    context: SourceContext,
  ): Promise<UploadOutcome[]> {
    const limits = this.config.upload;
    const outcomes: UploadOutcome[] = [];

    // Re-read inside the loop rather than once: ten files arriving together must
    // not each be checked against the quota as it stood before any of them.
    for (const candidate of candidates) {
      const usage = await this.repository.usage(context.projectId);

      if (usage.fileCount >= limits.maxFilesPerProject) {
        outcomes.push(rejected(candidate, REQUIREMENT_ERROR_CODES.TOO_MANY_FILES));
        continue;
      }

      if (usage.totalBytes + candidate.content.length > limits.maxProjectBytes) {
        outcomes.push(rejected(candidate, REQUIREMENT_ERROR_CODES.PROJECT_QUOTA_EXCEEDED));
        continue;
      }

      outcomes.push(await this.acceptFile(candidate, context));
    }

    return outcomes;
  }

  private async acceptFile(
    candidate: FileCandidate,
    context: SourceContext,
  ): Promise<UploadOutcome> {
    const outcome = this.validator.validate(candidate);

    if (!outcome.ok) {
      this.logger.warn(
        {
          projectId: context.projectId,
          correlationId: context.correlationId,
          code: outcome.rejection.code,
          detail: outcome.rejection.detail,
        },
        'Upload rejected',
      );

      await this.audit.record({
        type: 'REQUIREMENT_SOURCE_REJECTED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        reason: outcome.rejection.code,
      });

      return rejected(candidate, outcome.rejection.code);
    }

    const file = outcome.file;

    /* Malware scan, before anything is written. */
    const scanResult = await this.scan();

    if (scanResult === 'INFECTED' || scanResult === 'UNAVAILABLE') {
      await this.audit.record({
        type: 'REQUIREMENT_SOURCE_REJECTED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        reason: scanResult === 'INFECTED' ? 'MALWARE_DETECTED' : 'MALWARE_SCAN_UNAVAILABLE',
      });

      return rejected(
        candidate,
        scanResult === 'INFECTED'
          ? REQUIREMENT_ERROR_CODES.MALWARE_DETECTED
          : REQUIREMENT_ERROR_CODES.MALWARE_SCAN_UNAVAILABLE,
      );
    }

    /* Duplicate detection: same bytes, same project. */
    const duplicate = await this.repository.findByChecksum(context.projectId, file.checksumSha256);

    if (duplicate) {
      // Reported rather than stored. Processing the same bytes twice costs the
      // user quota and produces two identical sets of requirements to review.
      return {
        originalFilename: candidate.originalFilename,
        accepted: false,
        errorCode: REQUIREMENT_ERROR_CODES.DUPLICATE_FILE,
        errorMessage: requirementErrorMessage(REQUIREMENT_ERROR_CODES.DUPLICATE_FILE),
        duplicateOfSourceId: duplicate.sourceId,
      };
    }

    const sourceId = RequirementSourceRepository.newSourceId();
    const objectId = LocalFileStorageAdapter.newObjectId();

    try {
      await this.storage.put({
        key: { projectId: context.projectId, objectId },
        content: candidate.content,
        contentType: file.detectedMimeType ?? file.declaredMimeType,
        originalFilename: candidate.originalFilename,
      });
    } catch (cause) {
      this.logger.error({ cause, sourceId }, 'Storage write failed');
      return rejected(candidate, REQUIREMENT_ERROR_CODES.STORAGE_FAILURE);
    }

    const document = await this.repository.create({
      sourceId,
      projectId: context.projectId,
      kind: 'FILE',
      status: 'QUEUED',
      title: file.displayFilename,
      version: 0,
      reviewStatus: 'NOT_REVIEWED',
      originalFilename: candidate.originalFilename,
      displayFilename: file.displayFilename,
      extension: file.extension,
      declaredMimeType: file.declaredMimeType,
      ...(file.detectedMimeType ? { detectedMimeType: file.detectedMimeType } : {}),
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      storageObjectId: objectId,
      validationResult: 'PASSED',
      malwareScanResult: scanResult,
      currentRevision: 0,
      revisionCount: 0,
      retryCount: 0,
    });

    await this.audit.record({
      type: 'REQUIREMENT_FILE_UPLOADED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, extension: file.extension, sizeBytes: file.sizeBytes },
    });

    await this.audit.record({
      type: 'REQUIREMENT_SOURCE_VALIDATED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, notes: file.notes },
    });

    try {
      await this.queue.enqueueExtraction(context.projectId, sourceId, context.correlationId);

      await this.audit.record({
        type: 'EXTRACTION_QUEUED',
        projectId: context.projectId,
        correlationId: context.correlationId,
        metadata: { sourceId },
      });
    } catch (cause) {
      // The bytes are safe; only the job failed. FAILED with a retryable code is
      // the honest state — the user can retry, and nothing has been lost.
      this.logger.error({ cause, sourceId }, 'Could not queue extraction');
      await this.repository.setStatus(sourceId, 'FAILED', {
        failureCode: REQUIREMENT_ERROR_CODES.QUEUE_FAILURE,
        failureMessage: requirementErrorMessage(REQUIREMENT_ERROR_CODES.QUEUE_FAILURE),
      });
    }

    return {
      originalFilename: candidate.originalFilename,
      accepted: true,
      source: toSourceSummary(document),
    };
  }

  /**
   * The malware-scanning boundary.
   *
   * No real scanner ships in this phase. `none` records that no scan happened —
   * which is what `NOT_SCANNED` means, and it is deliberately not `CLEAN`;
   * `reject` refuses every file, for a deployment that would rather accept
   * nothing than accept something unscanned. A ClamAV adapter belongs with the
   * deployment work — see ADR-0016.
   */
  private scan(): Promise<'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'UNAVAILABLE'> {
    return Promise.resolve(this.config.malwareScanner === 'reject' ? 'UNAVAILABLE' : 'NOT_SCANNED');
  }

  /* ------------------------------------------------------------------ read */

  async readSource(context: SourceContext, sourceId: string): Promise<RequirementSource> {
    const document = await this.requireSource(context, sourceId);
    const revisionDocuments = await this.repository.listRevisions(sourceId);

    const revisions: ContentRevision[] = revisionDocuments.map(toContentRevision);
    const original = revisionDocuments.find((revision) => revision.revision === 0);
    const effective = revisionDocuments.find(
      (revision) => revision.revision === document.currentRevision,
    );

    return toFullSource(document, {
      ...(effective ? { effective: toExtractedContent(effective) } : {}),
      ...(original ? { original: toExtractedContent(original) } : {}),
      revisions,
    });
  }

  /* ------------------------------------------------------------ correction */

  async correctContent(
    sourceId: string,
    request: CorrectContentRequest,
    context: SourceContext,
  ): Promise<RequirementSource> {
    const document = await this.requireSource(context, sourceId);

    if (!hasExtractedContent(document.status)) {
      throw this.failure(REQUIREMENT_ERROR_CODES.CONTENT_NOT_AVAILABLE);
    }

    const current = await this.repository.findRevision(sourceId, document.currentRevision);

    if (!current) {
      throw this.failure(REQUIREMENT_ERROR_CODES.CONTENT_NOT_AVAILABLE);
    }

    const content = toExtractedContent(current);
    const corrections = new Map(request.corrections.map((c) => [c.blockId, c.text]));
    const changed: string[] = [];

    const blocks = content.blocks.map((block) => {
      const replacement = corrections.get(block.id);

      if (replacement === undefined || replacement === block.text) {
        return block;
      }

      changed.push(block.id);

      // A corrected block is certain by definition: a human read it and typed
      // what it says. Leaving the OCR confidence in place would keep flagging
      // text that has already been fixed.
      return { ...block, text: replacement, confidence: 1 };
    });

    const unknown = request.corrections
      .map((correction) => correction.blockId)
      .filter((blockId) => !content.blocks.some((block) => block.id === blockId));

    if (unknown.length > 0) {
      throw new ValidationFailedException(
        unknown.slice(0, 10).map((blockId) => ({
          path: 'corrections',
          message: `No block "${blockId}" in this source's current content.`,
          rule: 'unknown_block',
        })),
      );
    }

    const nextRevision = document.revisionCount;
    const corrected: ExtractedContent = {
      ...content,
      blocks,
      minimumConfidence: blocks.reduce((lowest, block) => Math.min(lowest, block.confidence), 1),
    };

    const updated = await this.repository.updateWithVersion(
      context.projectId,
      sourceId,
      request.version,
      {
        currentRevision: nextRevision,
        revisionCount: nextRevision + 1,
        ...contentCounters(corrected),
      },
    );

    if (!updated) {
      throw this.versionConflict(request.version);
    }

    await this.repository.appendRevision(
      context.projectId,
      sourceId,
      nextRevision,
      'CORRECTION',
      corrected,
      changed,
      request.note,
    );

    await this.audit.record({
      type: 'EXTRACTED_CONTENT_CORRECTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      // Counts and ids. Never the corrected text.
      metadata: { sourceId, revision: nextRevision, changedBlocks: changed.length },
    });

    return this.readSource(context, sourceId);
  }

  /**
   * Discards corrections by pointing back at revision 0.
   *
   * The corrections are not deleted — they stay in the history, and a further
   * correction appends after them. "Restore" means "the original is effective
   * again", which is a pointer move, not a rollback.
   */
  async restoreOriginal(
    sourceId: string,
    version: number,
    context: SourceContext,
  ): Promise<RequirementSource> {
    const document = await this.requireSource(context, sourceId);
    const original = await this.repository.findRevision(sourceId, 0);

    if (!original) {
      throw this.failure(REQUIREMENT_ERROR_CODES.CONTENT_NOT_AVAILABLE);
    }

    const content = toExtractedContent(original);
    const nextRevision = document.revisionCount;

    const updated = await this.repository.updateWithVersion(context.projectId, sourceId, version, {
      currentRevision: nextRevision,
      revisionCount: nextRevision + 1,
      ...contentCounters(content),
    });

    if (!updated) {
      throw this.versionConflict(version);
    }

    await this.repository.appendRevision(
      context.projectId,
      sourceId,
      nextRevision,
      'RESTORE',
      content,
      [],
      'Restored the original extraction',
    );

    await this.audit.record({
      type: 'EXTRACTED_CONTENT_RESTORED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, revision: nextRevision },
    });

    return this.readSource(context, sourceId);
  }

  /* ---------------------------------------------------------------- review */

  async markReviewed(
    sourceId: string,
    version: number,
    context: SourceContext,
  ): Promise<RequirementSource> {
    const document = await this.requireSource(context, sourceId);

    if (!hasExtractedContent(document.status)) {
      throw this.failure(REQUIREMENT_ERROR_CODES.CONTENT_NOT_AVAILABLE);
    }

    if (!canTransitionSource(document.status, 'READY')) {
      throw this.failure(REQUIREMENT_ERROR_CODES.CONTENT_NOT_AVAILABLE);
    }

    const updated = await this.repository.updateWithVersion(context.projectId, sourceId, version, {
      status: 'READY',
      reviewStatus: 'REVIEWED',
      reviewedAt: new Date(),
    });

    if (!updated) {
      throw this.versionConflict(version);
    }

    await this.audit.record({
      type: 'REQUIREMENT_SOURCE_REVIEWED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, revision: updated.currentRevision },
    });

    return this.readSource(context, sourceId);
  }

  /* ----------------------------------------------------------------- retry */

  async retry(sourceId: string, context: SourceContext): Promise<RequirementSource> {
    const document = await this.requireSource(context, sourceId);

    if (!isRetryable(document.status)) {
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_NOT_RETRYABLE);
    }

    if (document.retryCount >= this.config.extraction.maxAttempts) {
      throw this.failure(REQUIREMENT_ERROR_CODES.RETRY_LIMIT_REACHED);
    }

    if (document.failureCode && !isRetryableFailure(document.failureCode)) {
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_NOT_RETRYABLE);
    }

    await this.repository.incrementRetry(sourceId);
    await this.repository.setStatus(
      sourceId,
      'QUEUED',
      {},
      { failureCode: '', failureMessage: '' },
    );

    // A fresh idempotency key per attempt, keyed on the retry count. Reusing the
    // original would return the completed failed job instead of running again.
    await this.queue.enqueueExtraction(
      context.projectId,
      sourceId,
      context.correlationId,
      document.retryCount + 1,
    );

    await this.audit.record({
      type: 'REQUIREMENT_SOURCE_RETRIED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, attempt: document.retryCount + 1 },
    });

    return this.readSource(context, sourceId);
  }

  /* ---------------------------------------------------------------- delete */

  async deleteSource(sourceId: string, context: SourceContext): Promise<void> {
    const document = await this.requireSource(context, sourceId);
    const deleted = await this.repository.softDelete(context.projectId, sourceId);

    if (!deleted) {
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    // The record is soft-deleted; the bytes go now. Keeping a client's uploaded
    // document after they deleted it would be the wrong default, and the audit
    // trail records that it existed without needing the file itself.
    if (document.storageObjectId) {
      await this.storage
        .delete({ projectId: context.projectId, objectId: document.storageObjectId })
        .catch((cause: unknown) => {
          this.logger.error({ cause, sourceId }, 'Could not remove stored file after deletion');
        });
    }

    await this.audit.record({
      type: 'REQUIREMENT_SOURCE_DELETED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId, kind: document.kind },
    });
  }

  /* -------------------------------------------------------------- download */

  async openDownload(
    sourceId: string,
    context: SourceContext,
  ): Promise<{ stream: Readable; filename: string; contentType: string }> {
    const document = await this.requireSource(context, sourceId);

    if (document.kind !== 'FILE' || !document.storageObjectId) {
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    const stream = await this.storage.getStream({
      projectId: context.projectId,
      objectId: document.storageObjectId,
    });

    await this.audit.record({
      type: 'REQUIREMENT_FILE_DOWNLOADED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: { sourceId },
    });

    return {
      stream,
      filename: document.displayFilename ?? 'requirement-source',
      contentType:
        document.detectedMimeType ?? document.declaredMimeType ?? 'application/octet-stream',
    };
  }

  /* ---------------------------------------------------------------- shared */

  private async requireSource(context: SourceContext, sourceId: string) {
    const document = await this.repository.findAny(context.projectId, sourceId);

    if (!document) {
      // Identical to "not yours". A distinct message would confirm that a source
      // id exists in some other project, which is the enumeration this design
      // otherwise prevents.
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_NOT_FOUND);
    }

    if (document.status === 'DELETED') {
      throw this.failure(REQUIREMENT_ERROR_CODES.SOURCE_DELETED);
    }

    return document;
  }

  private failure(code: RequirementErrorCode): AppException {
    const status =
      code === REQUIREMENT_ERROR_CODES.SOURCE_NOT_FOUND ||
      code === REQUIREMENT_ERROR_CODES.SOURCE_DELETED
        ? API_ERROR_CODES.NOT_FOUND
        : API_ERROR_CODES.CONFLICT;

    return new AppException(status, { message: requirementErrorMessage(code), details: [] });
  }

  private versionConflict(expected: number): AppException {
    return new AppException(API_ERROR_CODES.CONFLICT, {
      message: 'This source was changed elsewhere since you loaded it. Reload before saving again.',
      details: [
        {
          path: 'version',
          message: `Expected version ${expected}, but the source has since changed.`,
          rule: 'version_conflict',
        },
      ],
    });
  }
}

function rejected(candidate: FileCandidate, code: RequirementErrorCode): UploadOutcome {
  return {
    originalFilename: candidate.originalFilename,
    accepted: false,
    errorCode: code,
    errorMessage: requirementErrorMessage(code),
  };
}

function isRetryableFailure(code: string): boolean {
  return (
    code === REQUIREMENT_ERROR_CODES.STORAGE_FAILURE ||
    code === REQUIREMENT_ERROR_CODES.QUEUE_FAILURE ||
    code === REQUIREMENT_ERROR_CODES.EXTRACTION_FAILED ||
    code === REQUIREMENT_ERROR_CODES.EXTRACTION_TIMEOUT ||
    code === REQUIREMENT_ERROR_CODES.OCR_FAILED ||
    code === REQUIREMENT_ERROR_CODES.MALWARE_SCAN_UNAVAILABLE
  );
}

/**
 * Turns pasted text into the same block shape a file produces.
 *
 * One representation for both kinds of source, so everything downstream — the
 * review UI, corrections, and Phase 4's evidence assembly — has a single thing
 * to consume rather than two.
 */
function textToContent(text: string): ExtractedContent {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = lines
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((entry) => entry.line.length > 0)
    .map((entry, index) => ({
      id: `b${index}`,
      kind: 'paragraph' as const,
      text: entry.line,
      reference: { lineNumber: entry.lineNumber, textVersion: 0 },
      confidence: 1,
      viaOcr: false,
    }));

  return {
    blocks,
    warnings: [],
    minimumConfidence: 1,
    usedOcr: false,
    extractedAt: new Date().toISOString(),
    extractor: 'pasted-text',
  };
}
