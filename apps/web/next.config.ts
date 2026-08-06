import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Defined in src/lib/security-headers.ts so the set is covered by a test.
// Note: it contains no Content-Security-Policy — see that file for why.
import { SECURITY_HEADERS } from './src/lib/security-headers';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  turbopack: {
    // Pinned to the monorepo root. Left to inference, Turbopack walks up looking
    // for a lockfile and can settle on one outside the repository entirely,
    // which silently changes how workspace packages resolve.
    root: fileURLToPath(new URL('../..', import.meta.url)),
  },

  // The UI package ships TypeScript source rather than a build artefact, so the
  // app and the design system stay in sync without a watch-and-rebuild loop.
  transpilePackages: ['@wdrg/ui'],

  typescript: {
    // A type error must fail the build. Never set this to true.
    ignoreBuildErrors: false,
  },

  async headers() {
    return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
