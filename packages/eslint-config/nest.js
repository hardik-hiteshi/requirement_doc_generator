import tseslint from 'typescript-eslint';

import { base } from './base.js';

/**
 * Flat config for the NestJS API application.
 *
 * NestJS relies on decorators and constructor parameter injection, which
 * legitimately trip a handful of type-aware rules.
 */
export const nest = tseslint.config(
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      /* Decorator factories are typed loosely upstream. */
      '@typescript-eslint/no-unsafe-argument': 'warn',

      /* Nest uses empty constructors purely for DI metadata. */
      '@typescript-eslint/no-useless-constructor': 'off',

      /* Interface-only "port" declarations are intentionally free of methods in
         some cases (marker types for injection tokens). */
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
    },
  },
  {
    // Repeated after the block above: `base` is spread first, so the block above
    // re-enables these rules for test files too. Test harnesses legitimately
    // handle loosely typed values — `getHttpServer()` returns `any`.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);

export default nest;
