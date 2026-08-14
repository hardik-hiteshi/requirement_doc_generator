import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitStore } from './rate-limit.store';

/**
 * Request ceilings.
 *
 * The store is exported because the operator surface reports how many keys are being
 * tracked, and the guard because it is registered globally in `main.ts` rather than
 * per controller — a limiter somebody has to remember to attach is a limiter that
 * will be missing from the next endpoint.
 */
@Module({
  imports: [AuditModule],
  providers: [RateLimitStore, RateLimitGuard],
  exports: [RateLimitStore, RateLimitGuard],
})
export class AbuseModule {}
