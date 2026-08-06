import type { Readable } from 'node:stream';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  detectInjectionSignals,
  isImageExtension,
  LOW_CONFIDENCE_THRESHOLD,
  REQUIREMENT_ERROR_CODES,
  requirementErrorMessage,
  type ExtractedContent,
  type RequirementErrorCode,
} from '@wdrg/contracts';

import { AuditService } from '../../audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import {
  FileExtractionError,
  FILE_STORAGE_PORT,
  LegacyConversionError,
  LEGACY_CONVERSION_PORT,
  type FileStoragePort,
  type LegacyConversionPort,
} from '../../ports';
import { ExtractionService } from '../extraction/extraction.service';
import { contentCounters } from '../requirement-source.mapper';
import { RequirementSourceRepository } from '../requirement-source.repository';
import { EXTRACTION_QUEUE_NAME } from './extraction.queue';
import { MongoJobQueueAdapter, type ClaimedJob } from './mongo-job-queue.adapter';

/**
 * The worker that reads queued files.
 *
 * It runs in the API process. That is a deliberate choice for this phase and a
 * bounded one: extraction is seconds of work per file at a workload of a handful
 * of files per project, and a separate worker process would add a deployment
 * unit, a second configuration surface and an operational story for keeping the
 * two in step — for no throughput anyone needs yet. The port and the queue are
 * both process-agnostic, so moving it out later is a deployment change, not a
 * rewrite.
 *
 * Two properties make in-process safe rather than merely convenient:
 *
 * **One job at a time.** No concurrency inside the worker, so a large PDF cannot
 * starve the event loop of every HTTP request at once.
 *
 * **Shutdown drains.** `onApplicationShutdown` stops the loop and waits for the
 * job in flight, so a deploy does not leave a source stuck in `EXTRACTING` until
 * the claim times out.
 */
@Injectable()
export class ExtractionWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ExtractionWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private inFlight?: Promise<void>;

  constructor(
    private readonly queue: MongoJobQueueAdapter,
    private readonly repository: RequirementSourceRepository,
    private readonly extraction: ExtractionService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE_PORT) private readonly storage: FileStoragePort,
    @Inject(LEGACY_CONVERSION_PORT) private readonly legacy: LegacyConversionPort,
  ) {}

  onModuleInit(): void {
    if (!this.config.extraction.workerEnabled) {
      // Tests drive `runOnce` directly, which makes extraction deterministic
      // rather than something that happens at some point after an upload.
      this.logger.log('Extraction worker disabled by configuration');
      return;
    }

    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopping) {
      return;
    }

    this.timer = setTimeout(() => {
      this.inFlight = this.tick().finally(() => this.schedule());
      void this.inFlight;
    }, this.config.extraction.pollIntervalMs);

    // Never hold the process open for a poll timer.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) {
      return;
    }

    this.running = true;

    try {
      // Drain rather than take one per interval: a batch upload of ten files
      // should not take ten polling intervals to start.
      while (!this.stopping && (await this.runOnce())) {
        /* keep going while there is work */
      }
    } catch (cause) {
      this.logger.error({ cause }, 'Extraction worker tick failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Claims and processes one job.
   *
   * @returns whether a job was found. Public so integration tests can drive the
   * pipeline deterministically instead of sleeping and hoping.
   */
  async runOnce(): Promise<boolean> {
    const job = await this.queue.claimNext(EXTRACTION_QUEUE_NAME);

    if (!job) {
      return false;
    }

    await this.process(job);
    return true;
  }

  private async process(job: ClaimedJob): Promise<void> {
    const source = await this.repository.findAny(job.projectId, job.sourceId);

    if (!source || source.status === 'DELETED') {
      // Deleted while queued. Not a failure — there is simply nothing to do.
      await this.queue.cancel(job.jobId);
      return;
    }

    await this.repository.setStatus(job.sourceId, 'EXTRACTING');
    await this.audit.record({
      type: 'EXTRACTION_STARTED',
      projectId: job.projectId,
      correlationId: job.correlationId,
      metadata: { sourceId: job.sourceId, attempt: job.attempts },
    });

    try {
      if (!source.storageObjectId) {
        throw new FileExtractionError('corrupted_file', 'The stored file is missing.', false);
      }

      let content = await readAll(
        await this.storage.getStream({
          projectId: job.projectId,
          objectId: source.storageObjectId,
        }),
      );

      let filename = source.displayFilename ?? 'source';

      /* Legacy conversion, where it is enabled and the file needs it. */
      if (source.extension === 'doc' || source.extension === 'xls') {
        const converted = await this.legacy.convert({
          format: source.extension,
          content,
          filename,
        });

        content = converted.content;
        filename = `${filename}.${converted.extension}`;

        await this.repository.setStatus(job.sourceId, 'EXTRACTING', {
          convertedFrom: source.extension,
        });
      }

      const usesOcr = isImageExtension(source.extension ?? '');

      if (usesOcr) {
        await this.repository.setStatus(job.sourceId, 'OCR_PROCESSING');
        await this.audit.record({
          type: 'OCR_STARTED',
          projectId: job.projectId,
          correlationId: job.correlationId,
          metadata: { sourceId: job.sourceId },
        });
      }

      const extracted = await this.extraction.extractContent({
        sourceId: job.sourceId,
        filename,
        content,
        allowOcr: this.config.ocr.enabled,
        isCancelled: () => this.queue.isCancellationRequested(job.jobId),
        onProgress: (percent, label) =>
          this.queue.reportProgress(job.jobId, 'extract', label, percent),
      });

      if (await this.queue.isCancellationRequested(job.jobId)) {
        await this.queue.cancel(job.jobId);
        await this.repository.setStatus(job.sourceId, 'FAILED', {
          failureCode: REQUIREMENT_ERROR_CODES.EXTRACTION_FAILED,
          failureMessage: 'Reading this file was cancelled.',
        });
        return;
      }

      await this.storeResult(job, extracted, usesOcr);
    } catch (cause) {
      await this.handleFailure(job, cause);
    }
  }

  private async storeResult(
    job: ClaimedJob,
    content: ExtractedContent,
    usedOcr: boolean,
  ): Promise<void> {
    // A re-extraction replaces the history: the previous revisions describe
    // content that no longer exists, and keeping them would let a "restore
    // original" bring back text from a different reading of the file.
    await this.repository.deleteRevisions(job.sourceId);
    await this.repository.appendRevision(job.projectId, job.sourceId, 0, 'EXTRACTION', content);

    const signals = detectInjectionSignals(content.blocks.map((block) => block.text).join('\n'));

    /*
     * Whether a human has to look at this.
     *
     * Anything OCR touched, anything with a warning, and anything with a
     * low-confidence block goes to REVIEW_REQUIRED. Only a clean digital
     * extraction goes straight to READY — and even then the user can still open
     * and correct it.
     */
    const needsReview =
      usedOcr ||
      content.usedOcr ||
      content.warnings.length > 0 ||
      content.minimumConfidence < LOW_CONFIDENCE_THRESHOLD;

    await this.repository.setStatus(
      job.sourceId,
      needsReview ? 'REVIEW_REQUIRED' : 'READY',
      {
        currentRevision: 0,
        revisionCount: 1,
        ...contentCounters(content),
        ...(signals.length > 0 ? { injectionSignals: signals.map((signal) => signal.id) } : {}),
      },
      { failureCode: '', failureMessage: '' },
    );

    await this.queue.complete(job.jobId);

    if (usedOcr) {
      await this.audit.record({
        type: 'OCR_COMPLETED',
        projectId: job.projectId,
        correlationId: job.correlationId,
        metadata: {
          sourceId: job.sourceId,
          minimumConfidence: Math.round(content.minimumConfidence * 100) / 100,
        },
      });
    }

    await this.audit.record({
      type: 'EXTRACTION_COMPLETED',
      projectId: job.projectId,
      correlationId: job.correlationId,
      metadata: {
        sourceId: job.sourceId,
        blocks: content.blocks.length,
        warnings: content.warnings.length,
        needsReview,
      },
    });
  }

  private async handleFailure(job: ClaimedJob, cause: unknown): Promise<void> {
    const { code, retryable } = classify(cause);

    this.logger.warn(
      { sourceId: job.sourceId, code, attempt: job.attempts, cause },
      'Extraction failed',
    );

    const disposition = await this.queue.fail(job.jobId, code, describe(cause), retryable);

    if (disposition === 'retrying') {
      // The queue will run it again; the source stays QUEUED so the workspace
      // keeps showing progress rather than flickering into a failure the user
      // does not need to act on.
      await this.repository.setStatus(job.sourceId, 'QUEUED');
      return;
    }

    await this.repository.setStatus(job.sourceId, 'FAILED', {
      failureCode: code,
      failureMessage: requirementErrorMessage(code),
    });

    const isOcrFailure = code === REQUIREMENT_ERROR_CODES.OCR_FAILED;

    await this.audit.record({
      type: isOcrFailure ? 'OCR_FAILED' : 'EXTRACTION_FAILED',
      projectId: job.projectId,
      correlationId: job.correlationId,
      reason: code,
      metadata: { sourceId: job.sourceId, attempts: job.attempts },
    });
  }
}

/** Maps a thrown error onto a user-facing code and a retry decision. */
function classify(cause: unknown): { code: RequirementErrorCode; retryable: boolean } {
  if (cause instanceof FileExtractionError) {
    switch (cause.reason) {
      case 'password_protected':
        return { code: REQUIREMENT_ERROR_CODES.PASSWORD_PROTECTED, retryable: false };
      case 'corrupted_file':
        return { code: REQUIREMENT_ERROR_CODES.CORRUPTED_FILE, retryable: false };
      case 'unsupported_format':
        return { code: REQUIREMENT_ERROR_CODES.UNSUPPORTED_FORMAT, retryable: false };
      case 'empty_document':
        return { code: REQUIREMENT_ERROR_CODES.FILE_EMPTY, retryable: false };
      case 'ocr_failed':
        return { code: REQUIREMENT_ERROR_CODES.OCR_FAILED, retryable: cause.retryable };
      case 'timeout':
        return { code: REQUIREMENT_ERROR_CODES.EXTRACTION_TIMEOUT, retryable: true };
      case 'too_large':
        return { code: REQUIREMENT_ERROR_CODES.EXTRACTION_LIMIT_EXCEEDED, retryable: false };
    }
  }

  if (cause instanceof LegacyConversionError) {
    return {
      code:
        cause.reason === 'not_configured' || cause.reason === 'converter_unavailable'
          ? REQUIREMENT_ERROR_CODES.LEGACY_FORMAT_UNAVAILABLE
          : cause.reason === 'password_protected'
            ? REQUIREMENT_ERROR_CODES.PASSWORD_PROTECTED
            : REQUIREMENT_ERROR_CODES.CORRUPTED_FILE,
      retryable: cause.retryable,
    };
  }

  // Anything unrecognised is treated as retryable. An unknown failure is more
  // often a transient one — a disk hiccup, a dropped connection — than a
  // permanent property of the file, and the attempt limit bounds the cost of
  // being wrong.
  return { code: REQUIREMENT_ERROR_CODES.EXTRACTION_FAILED, retryable: true };
}

/** Operator detail for the job record. Never returned to a caller. */
function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`.slice(0, 500);
  }

  return String(cause).slice(0, 500);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  return Buffer.concat(chunks);
}
