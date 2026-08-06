import {
  booleanFromString,
  csvSchema,
  httpUrlSchema,
  integerSchema,
  logLevelSchema,
  mongoUriSchema,
  nodeEnvSchema,
  portSchema,
} from '@wdrg/config';
import { z } from 'zod';

/**
 * The complete set of environment variables the API understands.
 *
 * Every variable must also appear in the repository `.env.example`, with a
 * comment and a safe default. Adding a variable without documenting it there is
 * treated as an incomplete change.
 */
export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,

  /* ---------------------------------------------------------------- server */
  API_PORT: portSchema(3001),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  /** Public origin of the API, used for OpenAPI server metadata. */
  API_PUBLIC_URL: httpUrlSchema('http://localhost:3001'),

  /* ------------------------------------------------------------- database */
  MONGODB_URI: mongoUriSchema(),
  /** Fail fast instead of buffering commands when Mongo is unreachable. */
  MONGODB_CONNECT_TIMEOUT_MS: integerSchema({ default: 10_000, min: 1_000, max: 120_000 }),

  /* -------------------------------------------------------------- logging */
  LOG_LEVEL: logLevelSchema,
  /** Human-readable log output. Intended for local development only. */
  LOG_PRETTY: booleanFromString(false),

  /* ------------------------------------------------------------- security */
  /** Browser origins allowed to call the API. Empty means same-origin only. */
  CORS_ALLOWED_ORIGINS: csvSchema(['http://localhost:3000']),
  /** Maximum accepted JSON body size, in bytes. */
  REQUEST_BODY_LIMIT_BYTES: integerSchema({ default: 1_048_576, min: 1_024, max: 52_428_800 }),

  /* ---------------------------------------------------------------- docs */
  /** Serve the interactive OpenAPI UI. Disabled by default in production. */
  OPENAPI_ENABLED: booleanFromString(true),
});

export type ApiEnvironment = z.infer<typeof apiEnvSchema>;
