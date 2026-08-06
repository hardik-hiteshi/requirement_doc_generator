import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { base } from './base.js';

/**
 * Flat config for React/Next.js code.
 *
 * `eslint-plugin-react` is deliberately absent: version 7.37.5 still calls
 * `context.getFilename()`, removed in ESLint 10, and crashes the run. Its
 * highest-value rules are covered elsewhere — hook correctness by
 * `eslint-plugin-react-hooks`, and JSX/Next-specific pitfalls by
 * `@next/eslint-plugin-next`. Re-add it once it supports ESLint 10.
 */
export const next = tseslint.config(
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      '@next/next': nextPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    /* Config files and instrumentation run in a Node context, where reading the
       environment is exactly the point. */
    files: ['*.config.ts', '*.config.mjs', 'instrumentation.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);

export default next;
