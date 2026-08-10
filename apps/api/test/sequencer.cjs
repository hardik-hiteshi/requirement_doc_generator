/**
 * Test order for the API integration suite.
 *
 * `requirement-sources.e2e-spec.ts` runs first, and that is a correctness
 * requirement rather than a preference.
 *
 * That suite is the only one that extracts PDFs, and pdfjs is ESM-only. The
 * extractor reaches it through `new Function('specifier', 'return import(specifier)')`,
 * because the transpiler rewrites a literal `import()` to `require()`, which
 * cannot load an ES module. A function built that way has no module referrer,
 * so Jest cannot attribute the import to the file that made it and falls back
 * to the runtime it registered most recently — which, for the second and later
 * suites in a worker process, is the *previous* suite's runtime. Jest has
 * already torn that environment down, and the import fails with
 * "You are trying to `import` a file after the Jest environment has been torn
 * down", leaving the extraction job unprocessed and the source stuck at QUEUED.
 *
 * Scheduling hands the first test file to the first idle worker, so putting
 * this suite at the head of the list makes it the first environment in its
 * process. Nothing has been torn down at that point, and the runtime Jest
 * falls back to is the suite's own. No other suite imports pdfjs, so no later
 * file in that process needs the import again.
 *
 * Everything else is ordered by path. These suites share one MongoDB and one
 * extraction queue, so a fixed order makes a contention failure reproducible
 * instead of dependent on a timing cache.
 *
 * Plain CommonJS on purpose: Jest loads the sequencer before any transform is
 * available, so a `.ts` file here would not compile.
 */

/** The suite that must own the pdfjs import. */
const PDF_SUITE = 'requirement-sources.e2e-spec.ts';

class ApiIntegrationSequencer {
  /**
   * @param {Array<{path: string}>} tests
   * @returns {Array<{path: string}>}
   */
  sort(tests) {
    return [...tests].sort((first, second) => {
      const rank = this.rank(first) - this.rank(second);

      return rank === 0 ? first.path.localeCompare(second.path) : rank;
    });
  }

  /**
   * @param {{path: string}} test
   * @returns {number}
   */
  rank(test) {
    return test.path.endsWith(PDF_SUITE) ? 0 : 1;
  }

  /**
   * Jest asks for this with `--onlyFailures`. Ordering is fixed either way.
   *
   * @param {Array<{path: string}>} tests
   * @returns {Array<{path: string}>}
   */
  allFailedTests(tests) {
    return this.sort(tests);
  }

  /**
   * The default sequencer records timings here to order later runs by duration.
   * This one does not use timings, so there is nothing to cache.
   */
  cacheResults() {}
}

module.exports = ApiIntegrationSequencer;
