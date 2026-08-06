import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule.forRoot({
      // Probes must answer quickly; a slow dependency should read as "not ready"
      // rather than hold the probe open until the monitor's own timeout.
      gracefulShutdownTimeoutMs: 1_000,
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
