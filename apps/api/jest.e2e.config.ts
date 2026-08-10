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
   * A process per pair of suites, and two things depend on this number.
   *
   * **It cannot be 1.** Every suite boots a real Nest application, and Mongoose's
   * default connection is a module global — so one suite's `app.close()` closes
   * the connection the next suite's application is holding, and its readiness
   * probe reports the database down. Separate processes give each application its
   * own Mongoose.
   *
   * **It cannot be large.** The suites share one MongoDB, including the
   * extraction job queue. Two suites driving extraction at the same moment can
   * claim each other's jobs — Phase 4 hit exactly this and turned the background
   * worker off, which removed the *polling* half of the problem but not the
   * queue itself.
   *
   * Two is the number that has been green in hosted CI since Phase 4. With
   * eleven suites it is tighter than it was; see the known limitations in the
   * Phase 6 notes.
   */
  maxWorkers: 2,
  clearMocks: true,
};

export default config;
