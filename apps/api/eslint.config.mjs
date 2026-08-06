import { nest } from '@wdrg/eslint-config/nest';

export default [
  {
    // A plain Node script that builds the binary test fixtures. It is outside
    // the TypeScript project, so the type-aware rules have nothing to work from.
    ignores: ['test/fixtures/generate-fixtures.mjs'],
  },
  ...nest,
];
