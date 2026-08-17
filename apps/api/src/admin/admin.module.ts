import { Module } from '@nestjs/common';

import { AbuseModule } from '../abuse/abuse.module';
import { AuditModule } from '../audit/audit.module';
import { RequirementsModule } from '../requirements/requirements.module';
import { RetentionModule } from '../retention/retention.module';
import { AdminProjectsService } from './admin-projects.service';
import { AdminQueueService } from './admin-queue.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

/**
 * The operator surface.
 *
 * `RequirementsModule` is imported for the job-queue port rather than a second
 * binding: retrying a job must perform the same transition the ingestion path does,
 * and two implementations would eventually disagree about what a reset means.
 */
@Module({
  imports: [AuditModule, AbuseModule, RetentionModule, RequirementsModule],
  controllers: [AdminController],
  providers: [AdminGuard, AdminProjectsService, AdminQueueService],
})
export class AdminModule {}
