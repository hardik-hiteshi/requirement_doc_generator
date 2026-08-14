/**
 * Environment for the API integration suite.
 *
 * Runs as a Jest `setupFiles` entry, which matters: `ConfigModule.forRoot()` is
 * evaluated when `app.module.ts` is *imported*, not when a test's `beforeAll`
 * runs. Setting these inside a spec would be too late, and the application
 * would come up with analysis disabled while the test asked why.
 *
 * The deterministic provider is what CI uses, deliberately. Hosted CI must not
 * download gigabytes of model weights to check business logic, and a real model
 * would make every assertion probabilistic. Production refuses this provider at
 * startup — see `production-policy.ts`.
 */
/*
 * No background extraction worker anywhere in this suite.
 *
 * It defaults to on, so every spec that boots `AppModule` starts a poller — and
 * they all share one MongoDB. A poller belonging to the analysis suite will
 * happily claim the ingestion suite's extraction job, which then never
 * completes from that suite's point of view. It failed on a runner and passed
 * here, which is the signature of exactly this kind of shared-state race.
 *
 * The one suite that needs extraction drives `worker.runOnce()` itself, which
 * is deterministic and was always the intent.
 */
process.env.EXTRACTION_WORKER_ENABLED ??= 'false';

/*
 * No request ceilings in the general integration suites.
 *
 * These suites create a project per test and drive whole workflows as fast as the
 * machine allows, all from one address — which is exactly the shape the limiter is
 * built to refuse. Leaving it on made 389 tests fail for a reason unrelated to
 * anything they assert, and a suite fighting a limiter proves nothing about the
 * subject it was written for.
 *
 * The limiter itself is exercised against a running application in
 * `operations.e2e-spec.ts`, which turns it on with its own tight ceilings by
 * overriding the config provider — the environment cannot be used for that, because
 * `ConfigModule` reads it when `app.module.ts` is imported.
 */
process.env.RATE_LIMIT_ENABLED ??= 'false';

process.env.AI_PROVIDER ??= 'deterministic';
process.env.AI_MODEL_PROFILE ??= 'deterministic-test';
process.env.AI_BASE_URL ??= 'http://127.0.0.1:11434';
