import { base } from '@wdrg/eslint-config/base';

export default [
  {
    ignores: [
      '.artifacts/**',
      'playwright-report/**',
      'test-results/**',
      // Plain Node build helpers, outside the TypeScript project.
      'scripts/**',
    ],
  },
  ...base,
];
