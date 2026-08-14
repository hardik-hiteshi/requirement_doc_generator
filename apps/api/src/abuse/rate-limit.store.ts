import { Injectable } from '@nestjs/common';
import { METRIC_NAMES, type RateLimitDecision, type RateLimitPolicy } from '@wdrg/contracts';

import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';

/**
 * Fixed-window counters, held in this process.
 *
 * ## Why not Redis
 *
 * A shared store would give one ceiling across every instance. This deployment runs
 * one API container, so the shared store would be a fourth service to run, monitor
 * and back up in order to coordinate a single participant. A Mongo-backed counter
 * would avoid the new container but put a write on the path of all 132 routes,
 * which is a real latency cost paid on every request to solve a problem this shape
 * of deployment does not have.
 *
 * The consequence is stated rather than hidden: behind N instances the effective
 * ceiling is N times the configured one. The interface to this store is narrow
 * enough — one method — that a shared implementation can replace it without the
 * guard changing, which is the point of it being a class rather than a closure.
 *
 * ## Memory is bounded
 *
 * A flood from many addresses would otherwise grow the map until the process died,
 * turning a defence into the very outage it exists to prevent. Entries are dropped
 * when the map exceeds its configured size, oldest window first — and since an
 * expired window is indistinguishable from an absent one, dropping is always safe:
 * the worst case is that a caller gets a fresh budget slightly early.
 */
@Injectable()
export class RateLimitStore {
  /** key -> when this window ends (ms) and how many requests it has seen. */
  private readonly windows = new Map<string, { expiresAt: number; count: number }>();

  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Counts one request against a key and says whether it may proceed.
   *
   * Counting happens whether or not the request is allowed, so a caller that keeps
   * hammering a closed window does not reset it — but the window's end is never
   * extended either, because a limiter that punishes retries by sliding the window
   * forward can lock somebody out indefinitely for a stuck client they cannot see.
   */
  consume(key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitDecision {
    this.evictIfNeeded(now);

    const windowMs = policy.windowSeconds * 1_000;
    const existing = this.windows.get(key);
    const window =
      existing && existing.expiresAt > now ? existing : { expiresAt: now + windowMs, count: 0 };

    window.count += 1;
    this.windows.set(key, window);

    this.metrics.setGauge(METRIC_NAMES.rateLimitTrackedKeys, this.windows.size);

    const allowed = window.count <= policy.limit;

    return {
      allowed,
      remaining: Math.max(0, policy.limit - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.expiresAt - now) / 1_000)),
      limit: policy.limit,
    };
  }

  /** How many keys are being tracked. Reported on the operator surface. */
  size(): number {
    return this.windows.size;
  }

  /** For tests, and for an operator who has just widened a limit. */
  clear(): void {
    this.windows.clear();
  }

  private evictIfNeeded(now: number): void {
    const max = this.config.rateLimit.maxKeys;

    if (this.windows.size < max) {
      return;
    }

    /* Expired windows first: they hold no information at all. */
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) {
        this.windows.delete(key);
      }
    }

    if (this.windows.size < max) {
      return;
    }

    /*
     * Still full: drop whatever is closest to expiring. Iteration order is insertion
     * order, so this is not strictly the soonest window, and it does not need to be
     * — the property required is that the map cannot grow without bound.
     */
    const excess = this.windows.size - max + 1;
    let dropped = 0;

    for (const key of this.windows.keys()) {
      if (dropped >= excess) {
        break;
      }

      this.windows.delete(key);
      dropped += 1;
    }
  }
}
