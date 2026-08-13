import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/app-config.module';
import { AppConfigService } from '../../config/app-config.service';
import { FILE_STORAGE_PORT } from '../../ports';
import { LocalFileStorageAdapter } from './local-file-storage.adapter';
import { S3FileStorageAdapter } from './s3-file-storage.adapter';

/**
 * Where uploaded bytes live, bound once.
 *
 * The binding used to sit inside the requirements module, which was the only thing that
 * needed it. Phase 11 gives it a second consumer — a project's logo is an upload like any
 * other — and two copies of "filesystem or S3, depending on configuration" is how one of
 * them ends up writing to the wrong place after a config change.
 *
 * So the choice is made here, once, and both modules import it. Callers still depend on
 * `FILE_STORAGE_PORT` rather than on an adapter, which is what keeps swapping the backing
 * store a change to this file alone.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    LocalFileStorageAdapter,
    S3FileStorageAdapter,
    {
      provide: FILE_STORAGE_PORT,
      inject: [AppConfigService, LocalFileStorageAdapter, S3FileStorageAdapter],
      useFactory: (
        config: AppConfigService,
        filesystem: LocalFileStorageAdapter,
        s3: S3FileStorageAdapter,
      ) => (config.upload.adapter === 's3' ? s3 : filesystem),
    },
  ],
  exports: [FILE_STORAGE_PORT],
})
export class FileStorageModule {}
