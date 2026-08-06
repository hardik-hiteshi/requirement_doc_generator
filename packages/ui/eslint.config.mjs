import { next } from '@wdrg/eslint-config/next';

/**
 * The design system is React, not a Next.js application: it has no routes, so
 * the Next rules that inspect a pages/app directory have nothing to check and
 * emit a spurious "Pages directory cannot be found" notice.
 */
export default [
  ...next,
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];
