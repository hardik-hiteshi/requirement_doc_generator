import { z } from 'zod';

/**
 * The web application's configuration module.
 *
 * This is the only file permitted to read `process.env`. Next.js inlines
 * `NEXT_PUBLIC_*` variables at build time, so the reads below must be literal
 * property accesses — a dynamic lookup would compile to `undefined` in the
 * browser bundle.
 *
 * Validation runs at module load, which means a misconfigured deployment fails
 * during the build rather than as a broken page in production.
 */
const publicEnvSchema = z.object({
  /** Absolute base URL of the API, without a trailing slash. */
  NEXT_PUBLIC_API_BASE_URL: z
    .url()
    .default('http://localhost:3001')
    .transform((value) => value.replace(/\/+$/, '')),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Requirement Documentation Generator'),
});

const parsed = publicEnvSchema.safeParse({
  // eslint-disable-next-line no-restricted-properties -- configuration module
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  // eslint-disable-next-line no-restricted-properties -- configuration module
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
});

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid public environment configuration:\n${problems}`);
}

export const publicEnv = Object.freeze(parsed.data);

export type PublicEnv = typeof publicEnv;
