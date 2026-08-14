import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { FileStorageModule } from '../requirements/storage/file-storage.module';
import { RetentionService } from './retention.service';
import { RetentionWorker } from './retention.worker';

/**
 * Retention enforcement.
 *
 * Reuses the storage module rather than binding a second adapter: a purge has to
 * remove the same objects the ingestion path wrote, and two bindings could disagree
 * about where those are.
 */
@Module({
  imports: [AuditModule, FileStorageModule],
  providers: [RetentionService, RetentionWorker],
  exports: [RetentionService, RetentionWorker],
})
export class RetentionModule {}
