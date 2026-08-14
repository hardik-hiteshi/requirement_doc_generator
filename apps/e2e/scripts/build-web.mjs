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
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const webRoot = resolve(packageRoot, '..', 'web');

// Kept in step with tests/support/environment.ts by the assertion below.
const API_URL = 'http://127.0.0.1:3211';
const DIST_DIR = '.next-e2e';

/*
 * `next build` rewrites this tracked file to point at whichever dist directory it
 * was given, so building for the suite leaves the repository dirty with a path the
 * ordinary build does not use. Restored afterwards: a run should not change tracked
 * files, and committing `.next-e2e` here breaks type resolution for everyone else.
 *
 * Restoring the previous contents is not enough on its own. A run that is killed
 * between the build and the restore leaves the suite's directory in the file, and
 * the next run would then faithfully put that back — so the reference is normalised
 * to the ordinary build's directory rather than merely preserved.
 */
const envTypes = resolve(webRoot, 'next-env.d.ts');
const envTypesBefore = readFileSync(envTypes, 'utf8').split(`${DIST_DIR}/`).join('.next/');

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

if (readFileSync(envTypes, 'utf8') !== envTypesBefore) {
  writeFileSync(envTypes, envTypesBefore);
}

if (result.error) {
  console.error(`Could not start the web build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
