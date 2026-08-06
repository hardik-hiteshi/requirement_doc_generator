import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

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
  ],
  providers: [
    {
      // Registered globally so no thrown value can escape without being mapped
      // into the standard envelope.
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
