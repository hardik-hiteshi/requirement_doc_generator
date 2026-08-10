import type { Config } from 'jest';

/**
 * PDF extraction, in a process of its own.
 *
 * ## Why this is a separate project rather than one more file in the main suite
 *
 * pdfjs is ESM-only. The extractor reaches it through
 * `new Function('specifier', 'return import(specifier)')`, because the
 * transpiler rewrites a literal `import()` to `require()`, which cannot load an
 * ES module. A function built that way has no module referrer, so Jest cannot
 * attribute the import to the file that made it and falls back to the runtime it
 * registered most recently. In a worker process that has already finished
 * another suite, that runtime has been torn down, and the import fails with
 * "You are trying to `import` a file after the Jest environment has been torn
 * down". The extraction job is then requeued with backoff, the source sits at
 * QUEUED, and the test fails for a reason that has nothing to do with PDFs.
 *
 * That is a property of the process, not of the machine or the clock. The first
 * fix ordered the suites so the PDF one ran first — which worked, and left
 * correctness resting on run order. This project removes the dependency: one
 * test file, its own process, so there is never a torn-down environment for the
 * import to land on, whatever order anything else runs in and however many
 * suites are added later.
 *
 * `maxWorkers: 1` is not a workaround for flakiness. With a single test file
 * there is nothing to parallelise, and pinning it states the invariant the
 * design depends on: this process belongs to this suite alone.
 *
 * `test/test-topology.e2e-spec.ts` asserts the split still holds. The settings
 * below are duplicated from `jest.e2e.config.ts` deliberately — see the note
 * there about Jest's TypeScript config loader.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFiles: ['<rootDir>/test/e2e-env.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', {}],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  clearMocks: true,
  testRegex: 'pdf-extraction\\.e2e-spec\\.ts$',
  maxWorkers: 1,
  // OCR on a scanned page is the slowest thing in the repository, and slower
  // again on a shared runner.
  testTimeout: 180_000,
};

export default config;
