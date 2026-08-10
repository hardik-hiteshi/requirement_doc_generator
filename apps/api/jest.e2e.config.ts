import type { Config } from 'jest';

/**
 * API integration suite. Boots the real Nest application over HTTP.
 *
 * Requires a reachable MongoDB (`pnpm docker:up` locally, a service container in
 * CI). Kept separate from the unit suite so `pnpm test` never depends on
 * infrastructure.
 *
 * PDF extraction is **not** in this project. It runs under `jest.pdf.config.ts`,
 * in a process of its own, for the reason documented there. Nothing in this
 * project may touch a PDF, and `test/test-topology.e2e-spec.ts` fails if
 * something starts to.
 *
 * The two configurations repeat the settings below rather than sharing a module.
 * Jest reads a TypeScript config through its own loader, which does not resolve a
 * relative import of a sibling source file — so a shared base would have to be
 * compiled first, and a config file that needs a build step is worse than eight
 * duplicated lines. Keep them in step by hand.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Before any import, because ConfigModule reads the environment when
  // app.module.ts is imported rather than when a test runs.
  setupFiles: ['<rootDir>/test/e2e-env.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', {}],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  testTimeout: 30_000,
  clearMocks: true,
  testRegex: '.*\\.e2e-spec\\.ts$',
  testPathIgnorePatterns: ['pdf-extraction\\.e2e-spec\\.ts$'],
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
   * Two is the number that has been green in hosted CI since Phase 4.
   */
  maxWorkers: 2,
  /*
   * Fixed order, for reproducibility only.
   *
   * No suite's correctness depends on it. It used to: the PDF suite had to run
   * first, which is exactly the fragility a dedicated project removed. Ordering
   * is pinned because these suites share one MongoDB, and a contention failure
   * you can reproduce is worth more than one you cannot.
   */
  testSequencer: '<rootDir>/test/sequencer.cjs',
};

export default config;
