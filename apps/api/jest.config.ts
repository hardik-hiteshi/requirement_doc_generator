import type { Config } from 'jest';

/**
 * Unit / service test suite. Runs with no external infrastructure so it can
 * execute on any machine and in any CI job. Anything that needs MongoDB belongs
 * in `jest.e2e.config.ts`.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // Options come from .swcrc, which the Nest build also uses, so tests and
    // production compile the decorators identically.
    '^.+\\.(t|j)s$': ['@swc/jest', {}],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
  restoreMocks: true,
};

export default config;
