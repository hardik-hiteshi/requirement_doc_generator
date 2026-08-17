import { Module } from '@nestjs/common';

import { AbuseModule } from '../abuse/abuse.module';
import { AuditModule } from '../audit/audit.module';
import { RetentionModule } from '../retention/retention.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [AuditModule, AbuseModule, RetentionModule],
  controllers: [AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}
