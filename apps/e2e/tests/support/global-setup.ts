import { mkdir } from 'node:fs/promises';

import { ARTIFACT_DIR } from './environment';
import { assertCleanSlate, resetTestData } from './database';

/**
 * Clears the suite's data before the first test, and checks that it worked.
 *
 * Stored data only — see `resetTestData`. Log files are truncated earlier, by
 * `scripts/prepare-run.mjs`, because Playwright starts the web servers before it
 * runs this hook and clearing them here would erase the run's own startup
 * output.
 *
 * Data is cleared on the way in rather than on the way out so that a failed run
 * leaves its database behind to inspect.
 */
export default async function globalSetup(): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await resetTestData();
  await assertCleanSlate();
}
