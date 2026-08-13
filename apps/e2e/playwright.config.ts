import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

import {
  API_LOG_PATH,
  API_PRODUCTION_LOG_PATH,
  API_PRODUCTION_URL,
  API_URL,
  apiEnv,
  ARTIFACT_DIR,
  isCi,
  PACKAGE_ROOT,
  productionApiEnv,
  WEB_LOG_PATH,
  WEB_PORT,
  WEB_URL,
  webEnv,
} from './tests/support/environment';

const apiRoot = resolve(PACKAGE_ROOT, '..', 'api');
const webRoot = resolve(PACKAGE_ROOT, '..', 'web');

/**
 * Server output is piped through `tee` rather than redirected.
 *
 * Playwright shows it in the console, which is what you want when a server fails
 * to start, *and* it lands in a file the tests can read — the suite asserts that
 * a recovery secret never appears in the application log, which requires the log
 * to be readable from inside a test.
 */
function captured(command: string, logPath: string): string {
  return `${command} 2>&1 | tee -a ${JSON.stringify(logPath)}`;
}

export default defineConfig({
  testDir: './tests',
  outputDir: resolve(ARTIFACT_DIR, 'test-results'),

  /*
   * Serial, single worker, deliberately — and it costs about half an hour.
   *
   * Every scenario drives one shared API and one shared database, and several
   * assert on process-wide state — the contents of the application log, the
   * cookies a browser context holds. Running them concurrently would make those
   * assertions depend on what another test happened to be doing.
   *
   * The log is the part that cannot be worked around. `expectSecretConfined` reads
   * the API, production-API and web logs in full and asserts a recovery secret was
   * never written to any of them; with several workers those files interleave output
   * from scenarios the assertion knows nothing about, so a pass would stop meaning
   * what it claims. A leak going unnoticed is a worse outcome than a slow suite, so
   * the suite stays serial.
   *
   * What that buys and what it costs, measured rather than assumed: a healthy full
   * run is roughly 25–30 minutes locally and on a hosted runner, for ~130 scenarios
   * that each walk the whole application. The CI job allows 45 minutes — headroom for
   * a retry and a slow runner, not a target. It is not there to absorb a regression:
   * the number above is what a green run takes, and a run that starts creeping toward
   * the limit is a signal to investigate rather than to raise the limit again. The
   * previous 30-minute limit cancelled the job outright, which reported nothing at all.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  // Generous: an OCR pass over a real image, and a Next.js production page load,
  // are both seconds rather than milliseconds.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  globalSetup: require.resolve('./tests/support/global-setup'),

  reporter: isCi
    ? [['github'], ['html', { outputFolder: resolve(ARTIFACT_DIR, 'report'), open: 'never' }]]
    : [['list'], ['html', { outputFolder: resolve(ARTIFACT_DIR, 'report'), open: 'never' }]],

  use: {
    baseURL: WEB_URL,
    // Retained only for a failure: a passing run should leave nothing behind to
    // sift through, and traces are large.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // A real, visible viewport rather than the Playwright default, so the
    // desktop assertions are made against the size the responsive suite calls
    // desktop.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: [
    {
      command: captured('node dist/main.js', API_LOG_PATH),
      cwd: apiRoot,
      env: apiEnv,
      url: `${API_URL}/api/health/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: captured('node dist/main.js', API_PRODUCTION_LOG_PATH),
      cwd: apiRoot,
      env: productionApiEnv,
      url: `${API_PRODUCTION_URL}/api/health/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: captured(
        `pnpm exec next start --port ${WEB_PORT} --hostname 127.0.0.1`,
        WEB_LOG_PATH,
      ),
      cwd: webRoot,
      env: webEnv,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
