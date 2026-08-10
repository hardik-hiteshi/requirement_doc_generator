import { nest } from '@wdrg/eslint-config/nest';

export default [
  {
    // Plain Node scripts, outside the TypeScript project, so the type-aware
    // rules have nothing to work from:
    //  - the generator for the binary test fixtures;
    //  - the Jest test sequencer, which Jest loads before any transform exists
    //    and which therefore cannot be TypeScript.
    ignores: ['test/fixtures/generate-fixtures.mjs', 'test/sequencer.cjs'],
  },
  ...nest,
];
