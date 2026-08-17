import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { METRIC_NAMES, outcomeClass } from '@wdrg/contracts';
import type { Response } from 'express';
import { finalize } from 'rxjs';

import { MetricsService } from './metrics.service';

/**
 * Counts every request, and how long it took.
 *
 * `wdrg_http_requests_total` was declared in the metrics contract in Phase 12 and
 * never emitted: help text, a type, and no code path that produced a sample. A
 * collector scraping this service saw retention and rate-limit series and nothing at
 * all about traffic, which is the first thing anyone looks at. This is what closes
 * that.
 *
 * ## Labelled by outcome, never by route
 *
 * One label, four values. A per-route counter would be a hundred and thirty series
 * before status codes multiply it, and no operator question needs that resolution —
 * "are requests failing" and "is the API slow" are both answered by outcome class,
 * and the audit trail already says *which* operation when a specific one matters.
 *
 * ## Measured in `finalize`
 *
 * So a failed request is counted too. Recording on success only would produce a
 * traffic graph that goes quiet exactly when something breaks, which is the moment
 * the graph is being looked at.
 */
@Injectable()
export class RequestMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const started = process.hrtime.bigint();
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      finalize(() => {
        const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;

        /*
         * The status as it stands when the response finishes. A thrown exception has
         * already been mapped by the filter by this point, so a refused or failed
         * request is classified by what the caller actually received.
         */
        const outcome = outcomeClass(response.statusCode);

        this.metrics.increment(METRIC_NAMES.requestsTotal, { outcome });
        this.metrics.observe(METRIC_NAMES.requestDurationSeconds, seconds, { outcome });
      }),
    );
  }
}
