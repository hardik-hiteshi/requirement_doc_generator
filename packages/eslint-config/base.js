import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Base flat config shared by every package in the monorepo.
 *
 * Rules here encode the non-negotiable code-quality standards:
 *  - no unjustified `any`
 *  - no silent error swallowing
 *  - no direct `process.env` access outside configuration modules
 */
export const base = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      /* Explicit types over inference leakage at module boundaries. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      /* Never swallow errors silently. */
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      /* Configuration discipline: process.env is read only by config modules. */
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read environment variables only inside a configuration module (see packages/config).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name!=/^(warn|error)$/]",
          message: 'Use the structured logger instead of console.*',
        },
      ],

      /* General hygiene */
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-param-reassign': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    /* Test files may use looser typing for fixtures and mocks. */
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/test/**', '**/tests/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-restricted-properties': 'off',
    },
  },
  prettier,
);

export default base;
