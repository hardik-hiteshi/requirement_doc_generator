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
   * One suite at a time, stated here rather than left to the `--runInBand` flag
   * in the script. These share a MongoDB and a job queue, so running two at once
   * would have one suite's worker draining another's jobs — and a config that
   * only holds when invoked through one particular command is a trap.
   */
  maxWorkers: 1,
  clearMocks: true,
};

export default config;
