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

process.env.AI_PROVIDER ??= 'deterministic';
process.env.AI_MODEL_PROFILE ??= 'deterministic-test';
process.env.AI_BASE_URL ??= 'http://127.0.0.1:11434';
