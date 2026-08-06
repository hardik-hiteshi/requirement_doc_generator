import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AllExceptionsFilter } from './common/errors';
import { LoggingModule } from './common/logging';
import { AppConfigModule } from './config';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

/**
 * Application root.
 *
 * The architecture is a modular monolith: feature modules with explicit
 * boundaries inside one deployable. Splitting into services before there is a
 * scaling reason would buy distributed-system problems and no benefit.
 *
 * Phase 1 wires only the cross-cutting infrastructure — configuration, logging,
 * persistence and health. Feature modules (projects, uploads, analysis,
 * documents, exports) are added by the phases that own them.
 */
@Module({
  imports: [AppConfigModule, LoggingModule, DatabaseModule, HealthModule],
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
