import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AppConfigModule } from '../config/app-config.module';
import { MalwareModule } from '../requirements/malware/malware.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule.forRoot({
      // Probes must answer quickly; a slow dependency should read as "not ready"
      // rather than hold the probe open until the monitor's own timeout.
      gracefulShutdownTimeoutMs: 1_000,
    }),
    AppConfigModule,
    // So readiness can report whether the malware scanner is working. A control
    // that is silently broken is worse than one that is absent.
    MalwareModule,
  ],
  controllers: [HealthController],
})
export class HealthModule {}
