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
process.env.AI_PROVIDER ??= 'deterministic';
process.env.AI_MODEL_PROFILE ??= 'deterministic-test';
process.env.AI_BASE_URL ??= 'http://127.0.0.1:11434';
