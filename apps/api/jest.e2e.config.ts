import type { Config } from 'jest';

/**
 * API integration suite. Boots the real Nest application over HTTP.
 *
 * Requires a reachable MongoDB (`pnpm docker:up` locally, a service container in
 * CI). Kept separate from the unit suite so `pnpm test` never depends on
 * infrastructure.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Before any import, because ConfigModule reads the environment when
  // app.module.ts is imported rather than when a test runs.
  setupFiles: ['<rootDir>/test/e2e-env.ts'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', {}],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  testTimeout: 30_000,
  /*
   * A process per suite.
   *
   * pdfjs is loaded through a real dynamic import so it escapes Jest's module
   * registry and becomes a *process*-level singleton. Run every suite in one
   * process and a spec that boots and tears down a Nest application leaves it in
   * a state where the next PDF extraction throws — which presented as a broken
   * extractor and was really shared state between unrelated files.
   *
   * Safe because the background extraction worker is off for the whole suite
   * (see `test/e2e-env.ts`): the only thing two suites could have contended over
   * was the job queue, and now each drives its own jobs explicitly.
   */
  maxWorkers: 2,
  clearMocks: true,
};

export default config;
