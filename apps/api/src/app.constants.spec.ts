import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { API_SERVICE_VERSION } from './app.constants';

/**
 * The version the service reports must be the version that was released.
 *
 * `API_SERVICE_VERSION` is a constant rather than a read of `package.json`, so the
 * compiled bundle has no filesystem dependency at runtime. The cost of that choice is
 * that it can drift: a release bumps the manifest, nobody edits the constant, and every
 * health payload and operator status view then reports a version that has not existed
 * for months. Which is exactly when somebody is asking "what is actually deployed".
 *
 * Its comment says it is "bumped as part of the release checklist". This is that
 * checklist, in a form that fails.
 */
describe('the reported service version', () => {
  const manifest = (path: string): { version?: string } =>
    JSON.parse(readFileSync(join(__dirname, path), 'utf8')) as { version?: string };

  it('matches the API package manifest', () => {
    expect(API_SERVICE_VERSION).toBe(manifest('../package.json').version);
  });

  it('matches the workspace root, so one release has one number', () => {
    expect(API_SERVICE_VERSION).toBe(manifest('../../../package.json').version);
  });

  it('matches the web application, which is released together with it', () => {
    /*
     * The two are deployed as a pair and the web bundle inlines the API origin at build
     * time, so a mismatch here means two halves of one release describing themselves
     * differently.
     */
    expect(API_SERVICE_VERSION).toBe(manifest('../../web/package.json').version);
  });

  it('is a plain semantic version, which is what a release tag can carry', () => {
    expect(API_SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
