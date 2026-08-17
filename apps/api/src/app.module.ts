import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AnalysisModule } from './analysis/analysis.module';
import { StackModule } from './stack/stack.module';
import { DocumentsModule } from './documents/documents.module';
import { ObservabilityModule } from './observability/observability.module';
import { RequestMetricsInterceptor } from './observability/request-metrics.interceptor';
import { RetentionModule } from './retention/retention.module';
import { EstimationModule } from './estimation/estimation.module';
import { AbuseModule } from './abuse/abuse.module';
import { RateLimitGuard } from './abuse/rate-limit.guard';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AllExceptionsFilter } from './common/errors';
import { LoggingModule } from './common/logging';
import { AppConfigModule } from './config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ProjectAccessModule } from './project-access/project-access.module';
import { ProjectsModule } from './projects/projects.module';
import { RequirementsModule } from './requirements/requirements.module';

/**
 * Application root.
 *
 * The architecture is a modular monolith: feature modules with explicit
 * boundaries inside one deployable. Splitting into services before there is a
 * scaling reason would buy distributed-system problems and no benefit.
 *
 * Phase 1 wired the cross-cutting infrastructure. Phase 2 adds the public
 * project surface: anonymous access, the project itself, and the audit trail
 * behind both. Later phases (extraction, analysis, documents, exports) are not
 * present.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    HealthModule,
    AuditModule,
    ProjectAccessModule,
    ProjectsModule,
    RequirementsModule,
    AnalysisModule,
    StackModule,
    EstimationModule,
    DocumentsModule,
    ObservabilityModule,
    AbuseModule,
    RetentionModule,
    AdminModule,
  ],
  providers: [
    {
      // Registered globally so no thrown value can escape without being mapped
      // into the standard envelope.
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      // Registered globally, and ahead of every other guard, so a new endpoint is
      // protected the moment it exists rather than when somebody remembers to
      // annotate it. Cost is checked before identity: refusing a flood should not
      // require verifying a session first, and a flood of unauthenticated requests
      // must not become a flood of audit writes.
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      // Registered globally so traffic is counted for every route rather than the
      // ones somebody remembered to instrument. `wdrg_http_requests_total` was
      // declared in Phase 12 and never emitted; this is what produces it.
      provide: APP_INTERCEPTOR,
      useClass: RequestMetricsInterceptor,
    },
  ],
})
export class AppModule {}
