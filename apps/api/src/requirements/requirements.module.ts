import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { ProjectAccessModule } from '../project-access/project-access.module';
import {
  FILE_EXTRACTION_PORT,
  JOB_QUEUE_PORT,
  LEGACY_CONVERSION_PORT,
  OCR_PROVIDER_PORT,
} from '../ports';
import { ExtractionService } from './extraction/extraction.service';
import { ImageExtractor } from './extraction/image-extractor';
import { DocxExtractor, XlsxExtractor } from './extraction/office-extractors';
import { PdfExtractor } from './extraction/pdf-extractor';
import { CsvExtractor, TxtExtractor } from './extraction/text-extractors';
import { LibreOfficeConversionAdapter } from './legacy/libreoffice-conversion.adapter';
import { MalwareModule } from './malware/malware.module';
import { FileStorageModule } from './storage/file-storage.module';
import { TesseractOcrAdapter } from './ocr/tesseract-ocr.adapter';
import { ExtractionQueue } from './queue/extraction.queue';
import { ExtractionWorker } from './queue/extraction.worker';
import { MongoJobQueueAdapter } from './queue/mongo-job-queue.adapter';
import { QueuedJob, QueuedJobSchema } from './queue/job.schema';
import { RequirementSourceController } from './requirement-source.controller';
import { RequirementSourceRepository } from './requirement-source.repository';
import { RequirementSourceService } from './requirement-source.service';
import { ExtractedContentRecord, ExtractedContentSchema } from './schemas/extracted-content.schema';
import {
  RequirementSourceRecord,
  RequirementSourceSchema,
} from './schemas/requirement-source.schema';
import { FileValidator } from './validation/file-validator';

/**
 * Requirement ingestion: upload, storage, extraction, OCR and review.
 *
 * This is where Phase 1's ports acquire their first adapters. Every binding
 * below is a token to a class, and no application code names a class — the
 * services depend on `FILE_STORAGE_PORT`, not on `LocalFileStorageAdapter`,
 * which is what makes an S3 adapter a one-line change here rather than an edit
 * across the module.
 */
@Module({
  imports: [
    AppConfigModule,
    AuditModule,
    ProjectAccessModule,
    MalwareModule,
    FileStorageModule,
    MongooseModule.forFeature([
      { name: RequirementSourceRecord.name, schema: RequirementSourceSchema },
      { name: ExtractedContentRecord.name, schema: ExtractedContentSchema },
      { name: QueuedJob.name, schema: QueuedJobSchema },
    ]),
    /*
     * Uploads are buffered in memory, not written to a temporary directory.
     *
     * Every file is validated by content signature before it may be stored, and
     * validation needs the bytes. Spooling to disk first would mean unvalidated,
     * attacker-supplied content sitting on the filesystem — briefly, but under a
     * path the application then has to clean up correctly on every error path.
     * The size ceiling is what makes buffering safe, and multer enforces it
     * before the request body is read rather than after.
     */
    MulterModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        limits: {
          fileSize: config.upload.maxFileBytes,
          files: config.upload.maxFilesPerRequest,
          fields: 8,
          fieldNameSize: 100,
        },
      }),
    }),
  ],
  controllers: [RequirementSourceController],
  providers: [
    RequirementSourceService,
    RequirementSourceRepository,
    FileValidator,
    ExtractionQueue,
    ExtractionWorker,

    /* Extractors, registered by the service that dispatches to them. */
    TxtExtractor,
    CsvExtractor,
    DocxExtractor,
    XlsxExtractor,
    PdfExtractor,
    ImageExtractor,
    ExtractionService,

    /* Adapters. Concrete classes, bound to tokens below. */
    MongoJobQueueAdapter,
    TesseractOcrAdapter,
    LibreOfficeConversionAdapter,

    /* Storage itself is bound in FileStorageModule, which both this module and
       project branding import. */
    { provide: JOB_QUEUE_PORT, useExisting: MongoJobQueueAdapter },
    { provide: FILE_EXTRACTION_PORT, useExisting: ExtractionService },
    { provide: OCR_PROVIDER_PORT, useExisting: TesseractOcrAdapter },
    { provide: LEGACY_CONVERSION_PORT, useExisting: LibreOfficeConversionAdapter },
  ],
  /*
   * The job-queue port is exported so the operator surface can retry a job through the
   * same transition the ingestion path uses. A second binding elsewhere would eventually
   * disagree with this one about what resetting a job means.
   */
  exports: [
    RequirementSourceService,
    RequirementSourceRepository,
    ExtractionWorker,
    JOB_QUEUE_PORT,
  ],
})
export class RequirementsModule {}
