import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Defined in src/lib/security-headers.ts so the set is covered by a test.
// Note: it contains no Content-Security-Policy — see that file for why.
import { SECURITY_HEADERS } from './src/lib/security-headers';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Traced output for the deployable image: the server plus only the dependencies it
  // actually reaches, rather than a `node_modules` tree copied wholesale. Set
  // unconditionally, because a build that produces one artefact in CI and a different
  // one locally is how a container works on a laptop and not on a runner.
  output: 'standalone',

  // The browser E2E suite builds this app against a different API origin, and
  // `NEXT_PUBLIC_*` values are inlined at build time — so that build cannot share
  // an output directory with the development one without silently poisoning it.
  // Unset everywhere else, which leaves the Next.js default of `.next`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),

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
