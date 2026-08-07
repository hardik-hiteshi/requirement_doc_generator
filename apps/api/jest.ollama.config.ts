import type { Config } from 'jest';

/**
 * The optional local validation suite.
 *
 * Standalone rather than extending the e2e config: hosted CI must never pick
 * this up, and a config that shares a file with the CI one is a config someone
 * eventually wires into CI by accident. CI must not download gigabytes of model
 * weights to check business logic — the deterministic provider covers that
 * ground far faster and without the variance.
 *
 * Run it deliberately, against a model you have pulled:
 *   pnpm --filter @wdrg/api test:ollama
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.local-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', {}],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  // A local model on a CPU is slow. This bounds the suite, not a request.
  testTimeout: 600_000,
  clearMocks: true,
};

export default config;
