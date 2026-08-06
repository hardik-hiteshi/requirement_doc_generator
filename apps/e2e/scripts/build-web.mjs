#!/usr/bin/env node
/**
 * Builds the Next.js application the browser E2E suite runs against.
 *
 * This cannot reuse the ordinary `pnpm build` output. `NEXT_PUBLIC_*` values are
 * inlined at build time, and the suite serves the app on its own port against an
 * API on another — so it needs its own build, written to its own directory
 * (`.next-e2e`) so the development build stays untouched.
 *
 * Run before `playwright test`, not from `webServer`, so a build failure is
 * reported as a build failure rather than as a server that never came up.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const webRoot = resolve(packageRoot, '..', 'web');

// Kept in step with tests/support/environment.ts by the assertion below.
const API_URL = 'http://127.0.0.1:3211';
const DIST_DIR = '.next-e2e';

const result = spawnSync('pnpm', ['exec', 'next', 'build'], {
  cwd: webRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_DIST_DIR: DIST_DIR,
    NEXT_PUBLIC_API_BASE_URL: API_URL,
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

if (result.error) {
  console.error(`Could not start the web build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
