import { Global, Module } from '@nestjs/common';

import { MetricsService } from './metrics.service';

/**
 * Metrics, available everywhere.
 *
 * Global because the things worth counting are spread across every module — a guard
 * refusing a request, an exporter producing a file, a sweep purging a project — and
 * threading a provider through each module's imports to increment a number would add
 * ceremony without adding safety.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
