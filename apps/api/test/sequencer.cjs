/**
 * Test order for the API integration suite.
 *
 * Ordering is by path, and it is for **reproducibility only** — no suite's
 * correctness depends on where it lands in the run. It used to: PDF extraction
 * had to be the first environment in its worker process, because pdfjs cannot be
 * imported from a Jest runtime that has already been torn down. That suite now
 * has a Jest project and a process of its own (`jest.pdf.config.ts`), which
 * removed the dependency rather than scheduling around it.
 *
 * What is left is worth keeping. These suites share one MongoDB and one
 * extraction queue, so a fixed order makes a contention failure reproducible
 * instead of dependent on Jest's timing cache.
 *
 * Set `E2E_ORDER=reverse` to run them back to front. That is how the claim
 * "order does not matter" gets tested rather than asserted.
 *
 * Plain CommonJS on purpose: Jest loads the sequencer before any transform is
 * available, so a `.ts` file here would not compile.
 */

const REVERSED = process.env.E2E_ORDER === 'reverse';

class ApiIntegrationSequencer {
  /**
   * @param {Array<{path: string}>} tests
   * @returns {Array<{path: string}>}
   */
  sort(tests) {
    const sorted = [...tests].sort((first, second) => first.path.localeCompare(second.path));

    return REVERSED ? sorted.reverse() : sorted;
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
