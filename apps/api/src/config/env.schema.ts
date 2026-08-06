import {
  booleanFromString,
  csvSchema,
  httpUrlSchema,
  integerSchema,
  logLevelSchema,
  mongoUriSchema,
  nodeEnvSchema,
  portSchema,
  secretSchema,
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

  /* ------------------------------------------------------- project access */
  /** Absolute public URL of the web application; used to build recovery links. */
  WEB_PUBLIC_URL: httpUrlSchema('http://localhost:3000'),

  /**
   * Signs project session cookies. Rotating it invalidates every live session,
   * which is the intended emergency lever. Required in production; a fixed
   * development value keeps local restarts from logging everyone out.
   */
  PROJECT_SESSION_SECRET: secretSchema(32).default('development-only-session-secret-value-000000'),
  /** How long a project session cookie stays valid. */
  PROJECT_SESSION_TTL_SECONDS: integerSchema({ default: 604_800, min: 300, max: 2_592_000 }),
  /** How long an untouched project survives before it expires. */
  PROJECT_EXPIRY_DAYS: integerSchema({ default: 30, min: 1, max: 365 }),

  /* --------------------------------------------- requirement ingestion */
  /** Where the local storage adapter keeps uploaded files. Never web-served. */
  UPLOAD_STORAGE_ROOT: z.string().min(1).default('./storage/uploads'),
  /** Largest single upload. Independent of the JSON body limit above. */
  UPLOAD_MAX_FILE_BYTES: integerSchema({ default: 26_214_400, min: 1_024, max: 268_435_456 }),
  /** Total bytes one project may hold across every file. */
  UPLOAD_MAX_PROJECT_BYTES: integerSchema({ default: 262_144_000, min: 1_024, max: 2_147_483_648 }),
  /** How many files one project may hold. */
  UPLOAD_MAX_FILES_PER_PROJECT: integerSchema({ default: 50, min: 1, max: 1_000 }),
  /** How many files may arrive in a single multipart request. */
  UPLOAD_MAX_FILES_PER_REQUEST: integerSchema({ default: 10, min: 1, max: 100 }),
  /** Longest accepted filename, before normalisation. */
  UPLOAD_MAX_FILENAME_LENGTH: integerSchema({ default: 255, min: 16, max: 1_024 }),

  /* ------------------------------------------------------------ extraction */
  /** Wall-clock ceiling for reading one source. Bounds a hostile file. */
  EXTRACTION_TIMEOUT_MS: integerSchema({ default: 120_000, min: 5_000, max: 900_000 }),
  /** Attempts, including the first. Beyond this a source needs re-uploading. */
  EXTRACTION_MAX_ATTEMPTS: integerSchema({ default: 3, min: 1, max: 10 }),
  /** Base delay for the retry backoff. Doubles with each attempt. */
  EXTRACTION_RETRY_BACKOFF_MS: integerSchema({ default: 2_000, min: 100, max: 300_000 }),
  /** How often the worker looks for queued jobs. */
  EXTRACTION_POLL_INTERVAL_MS: integerSchema({ default: 1_000, min: 100, max: 60_000 }),
  /** A claimed job whose worker died is reclaimed after this long. */
  EXTRACTION_CLAIM_TIMEOUT_MS: integerSchema({ default: 180_000, min: 10_000, max: 3_600_000 }),
  /** Set false to leave jobs queued — used by tests that drive the worker directly. */
  EXTRACTION_WORKER_ENABLED: booleanFromString(true),
  /** Ceiling on blocks from one source, so a pathological file cannot exhaust memory. */
  EXTRACTION_MAX_BLOCKS: integerSchema({ default: 20_000, min: 100, max: 200_000 }),
  /** Spreadsheet rows read per sheet. */
  EXTRACTION_MAX_ROWS: integerSchema({ default: 5_000, min: 10, max: 100_000 }),
  /** PDF pages read per document. */
  EXTRACTION_MAX_PAGES: integerSchema({ default: 500, min: 1, max: 5_000 }),
  /**
   * Decompression ceiling for ZIP-container formats (DOCX, XLSX). A 1 MB file
   * that expands to 1 GB is a zip bomb, not a document.
   */
  EXTRACTION_MAX_UNCOMPRESSED_BYTES: integerSchema({
    default: 209_715_200,
    min: 1_048_576,
    max: 2_147_483_648,
  }),

  /* ------------------------------------------------------------------ ocr */
  /** Set false where no OCR engine is installed; image sources then fail clearly. */
  OCR_ENABLED: booleanFromString(true),
  /** Path to the Tesseract binary. */
  OCR_TESSERACT_BINARY: z.string().min(1).default('tesseract'),
  /** Tesseract language codes, e.g. `eng` or `eng+deu`. */
  OCR_LANGUAGES: z.string().min(1).default('eng'),
  OCR_TIMEOUT_MS: integerSchema({ default: 60_000, min: 5_000, max: 600_000 }),
  /** Below this mean word confidence the page is flagged for review. */
  OCR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),

  /* --------------------------------------------------- legacy conversion */
  /**
   * Off by default. A converter is a large external binary, and no deployment
   * should acquire one as a side effect of upgrading. Where this is unset, .doc
   * and .xls are rejected with an explanation rather than silently accepted.
   */
  LEGACY_CONVERSION_ENABLED: booleanFromString(false),
  /** Path to the headless LibreOffice binary used for conversion. */
  LEGACY_CONVERSION_BINARY: z.string().min(1).default('soffice'),
  LEGACY_CONVERSION_TIMEOUT_MS: integerSchema({ default: 120_000, min: 5_000, max: 600_000 }),

  /* -------------------------------------------------------------- malware */
  /**
   * `none` records NOT_SCANNED and keeps the file; `reject` refuses every file
   * because no scanner is available. A real scanner adapter arrives with the
   * deployment phase — see ADR-0016.
   */
  MALWARE_SCANNER: z.enum(['none', 'reject']).default('none'),

  /* ---------------------------------------------------------------- docs */
  /** Serve the interactive OpenAPI UI. Disabled by default in production. */
  OPENAPI_ENABLED: booleanFromString(true),
});

export type ApiEnvironment = z.infer<typeof apiEnvSchema>;
