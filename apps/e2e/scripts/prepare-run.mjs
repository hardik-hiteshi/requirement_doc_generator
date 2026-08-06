#!/usr/bin/env node
/**
 * Clears the captured server logs before a run.
 *
 * This cannot live in Playwright's `globalSetup`: the web servers are started
 * first, so truncating from there would delete the startup output the tests then
 * scan — and leave a run's own log looking empty. Doing it here, before
 * Playwright is invoked at all, keeps each run's log to that run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactDir = resolve(packageRoot, '.artifacts');

await mkdir(artifactDir, { recursive: true });

for (const name of ['api.log', 'api-production.log', 'web.log']) {
  await writeFile(resolve(artifactDir, name), '');
}
