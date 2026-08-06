import { resolve } from 'node:path';

/**
 * The browser E2E suite's configuration module — the only file here permitted to
 * read `process.env`.
 *
 * Everything the suite runs against is started by Playwright itself: a NestJS
 * API, a production build of the Next.js application, and a second API in
 * production mode used only to observe the cookie flags production would set.
 * Nothing is shared with a developer's running `pnpm dev` stack, which is why
 * these ports and database names are deliberately unusual.
 */

/** True on a hosted runner. Controls retries and server reuse, nothing else. */
export const isCi = Boolean(process.env.CI);

/* ------------------------------------------------------------------- ports */

/** Next.js production server under test. */
export const WEB_PORT = 3210;
/** NestJS API under test. */
export const API_PORT = 3211;
/** A second API instance in production mode. Never loaded in a browser. */
export const API_PRODUCTION_PORT = 3212;

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const API_PRODUCTION_URL = `http://127.0.0.1:${API_PRODUCTION_PORT}`;

/* ---------------------------------------------------------------- database */

const MONGO_HOST = process.env.E2E_MONGODB_HOST ?? '127.0.0.1';
const MONGO_PORT = process.env.MONGODB_HOST_PORT ?? '27017';

/** Isolated from every other suite: the API integration tests use `wdrg_e2e`. */
export const DATABASE_NAME = 'wdrg_e2e_browser';
export const PRODUCTION_DATABASE_NAME = 'wdrg_e2e_browser_production';

export function mongoUri(databaseName: string): string {
  return `mongodb://${MONGO_HOST}:${MONGO_PORT}/${databaseName}?directConnection=true`;
}

/* ----------------------------------------------------------------- secrets */

/**
 * Fixed so a restart does not invalidate sessions mid-run. It signs nothing
 * outside this suite and never reaches a real deployment.
 */
const SESSION_SECRET = 'e2e-browser-suite-session-secret-0000000000';

/* --------------------------------------------------------------- artefacts */

export const PACKAGE_ROOT = resolve(__dirname, '..', '..');
export const ARTIFACT_DIR = resolve(PACKAGE_ROOT, '.artifacts');
export const API_LOG_PATH = resolve(ARTIFACT_DIR, 'api.log');
export const API_PRODUCTION_LOG_PATH = resolve(ARTIFACT_DIR, 'api-production.log');
export const WEB_LOG_PATH = resolve(ARTIFACT_DIR, 'web.log');

export const WEB_DIST_DIR = '.next-e2e';

/* --------------------------------------------------------- process recipes */

const baseApiEnv = {
  API_HOST: '127.0.0.1',
  CORS_ALLOWED_ORIGINS: WEB_URL,
  WEB_PUBLIC_URL: WEB_URL,
  PROJECT_SESSION_SECRET: SESSION_SECRET,
  // Short enough that nothing lingers between runs, long enough that a slow
  // suite never expires a session mid-scenario.
  PROJECT_SESSION_TTL_SECONDS: '3600',
  PROJECT_EXPIRY_DAYS: '30',
  // Debug rather than warn: the suite asserts that a recovery secret never
  // reaches the logs, and that assertion is only worth making against the most
  // verbose output the application can produce.
  LOG_LEVEL: 'debug',
  OPENAPI_ENABLED: 'false',

  /* Phase 3. Uploads go to a scratch directory under this package's artefacts,
     so a run never touches a developer's own storage root. */
  UPLOAD_STORAGE_ROOT: resolve(__dirname, '..', '..', '.artifacts', 'storage'),
  /* The worker runs here, unlike in the API integration suite: the browser tests
     are about what a user sees, and a user does not call a worker method. */
  EXTRACTION_WORKER_ENABLED: 'true',
  EXTRACTION_POLL_INTERVAL_MS: '250',
} as const;

export const apiEnv: Record<string, string> = {
  ...baseApiEnv,
  NODE_ENV: 'test',
  API_PORT: String(API_PORT),
  API_PUBLIC_URL: API_URL,
  MONGODB_URI: mongoUri(DATABASE_NAME),
};

/**
 * The same API, in production mode.
 *
 * Cookie flags differ by environment (`secure` is on only in production), and
 * asserting that from a test-mode server would prove nothing. It gets its own
 * database so it cannot see, or disturb, the projects the browser tests create.
 */
export const productionApiEnv: Record<string, string> = {
  ...baseApiEnv,
  NODE_ENV: 'production',
  API_PORT: String(API_PRODUCTION_PORT),
  API_PUBLIC_URL: API_PRODUCTION_URL,
  MONGODB_URI: mongoUri(PRODUCTION_DATABASE_NAME),
};

export const webEnv: Record<string, string> = {
  NODE_ENV: 'production',
  NEXT_DIST_DIR: WEB_DIST_DIR,
  NEXT_PUBLIC_API_BASE_URL: API_URL,
  NEXT_TELEMETRY_DISABLED: '1',
};
