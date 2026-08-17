import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { RetentionService } from './retention.service';

/**
 * Runs the retention sweep on a timer.
 *
 * The same shape as the extraction worker, for the same reasons: a self-scheduling
 * `setTimeout` rather than an interval, so a slow sweep cannot overlap itself; the
 * timer unreferenced, so it never holds the process open; and a shutdown hook, so a
 * sweep in progress is awaited rather than abandoned half-done.
 *
 * No scheduler package. `@nestjs/schedule` would bring cron expressions this needs
 * none of — the policy is "look every so often", not "at 3am" — and a second timing
 * mechanism in a codebase that already has one is a second thing to reason about
 * when something does not run.
 *
 * ## Off by default
 *
 * Retention deletes data. A default that quietly removed things from a machine
 * somebody was using to evaluate the product would be indefensible, so a deployment
 * turns it on having chosen its windows. Production startup warns when it is off,
 * because an installation that never purges keeps client requirement documents for
 * ever.
 */
@Injectable()
export class RetentionWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    private readonly retention: RetentionService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.config.retention.enabled) {
      this.logger.log('Retention sweeps are disabled; nothing will be purged.');
      return;
    }

    /*
     * The first sweep waits one interval rather than running at boot. Startup is
     * when a deployment is least able to absorb a burst of deletes, and nothing is
     * urgent: everything eligible now was eligible an hour ago.
     */
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    /* Let a sweep in flight finish, so a purge is not left half-applied. */
    await this.running;
  }

  /** Runs a sweep now. Used by the operator surface and by the tests. */
  async runOnce(): Promise<void> {
    this.running = this.retention.sweep().catch((error: unknown) => {
      this.logger.error({ err: error }, 'A retention sweep failed');
    });

    await this.running;
    this.running = undefined;
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule());
    }, this.config.retention.sweepIntervalMs);

    /* Never hold the process open for a sweep timer. */
    this.timer.unref();
  }
}
