import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditService } from './audit.service';
import { AuditEvent, AuditEventSchema } from './schemas/audit-event.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: AuditEvent.name, schema: AuditEventSchema }])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
