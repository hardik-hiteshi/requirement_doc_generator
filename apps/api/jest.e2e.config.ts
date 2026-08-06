import type { Config } from 'jest';

/**
 * API integration suite. Boots the real Nest application over HTTP.
 *
 * Requires a reachable MongoDB (`pnpm docker:up` locally, a service container in
 * CI). Kept separate from the unit suite so `pnpm test` never depends on
 * infrastructure.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['@swc/jest', {}],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  testTimeout: 30_000,
  clearMocks: true,
};

export default config;
