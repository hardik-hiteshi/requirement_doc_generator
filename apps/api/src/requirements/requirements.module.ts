import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { ProjectAccessModule } from '../project-access/project-access.module';
import {
  FILE_EXTRACTION_PORT,
  FILE_STORAGE_PORT,
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
import { LocalFileStorageAdapter } from './storage/local-file-storage.adapter';
import { S3FileStorageAdapter } from './storage/s3-file-storage.adapter';
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
    LocalFileStorageAdapter,
    S3FileStorageAdapter,
    MongoJobQueueAdapter,
    TesseractOcrAdapter,
    LibreOfficeConversionAdapter,

    /*
     * Storage is chosen by configuration, not by environment.
     *
     * A deployment says which adapter it wants; nothing is inferred from
     * NODE_ENV. That is what lets a staging environment run the same object
     * storage as production, and what stops "it worked in development" from
     * meaning "it used a different storage engine".
     */
    {
      provide: FILE_STORAGE_PORT,
      inject: [AppConfigService, LocalFileStorageAdapter, S3FileStorageAdapter],
      useFactory: (
        config: AppConfigService,
        filesystem: LocalFileStorageAdapter,
        s3: S3FileStorageAdapter,
      ) => (config.upload.adapter === 's3' ? s3 : filesystem),
    },

    { provide: JOB_QUEUE_PORT, useExisting: MongoJobQueueAdapter },
    { provide: FILE_EXTRACTION_PORT, useExisting: ExtractionService },
    { provide: OCR_PROVIDER_PORT, useExisting: TesseractOcrAdapter },
    { provide: LEGACY_CONVERSION_PORT, useExisting: LibreOfficeConversionAdapter },
  ],
  exports: [RequirementSourceService, RequirementSourceRepository, ExtractionWorker],
})
export class RequirementsModule {}
