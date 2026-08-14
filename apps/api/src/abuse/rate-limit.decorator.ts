import { SetMetadata } from '@nestjs/common';
import type { RateLimitClass } from '@wdrg/contracts';

export const RATE_LIMIT_CLASS = 'wdrg:rate-limit-class';

/**
 * Declares which budget a route spends from.
 *
 * Applied at the handler or the controller. Absent, a route is classified by its
 * method — a read draws on `default`, a write on `mutation` — so a new endpoint is
 * protected the moment it exists rather than the moment somebody remembers to
 * annotate it. The decorator is for the routes whose cost is not visible from their
 * verb: a `POST` that runs a model and a `GET` that renders a PDF both look
 * ordinary and are not.
 */
export const RateLimit = (rateClass: RateLimitClass): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_CLASS, rateClass);
