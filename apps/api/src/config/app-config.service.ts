import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LogLevel, NodeEnvironment } from '@wdrg/config';

import type { ApiEnvironment } from './env.schema';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly publicUrl: string;
}

export interface DatabaseConfig {
  readonly uri: string;
  readonly connectTimeoutMs: number;
}

export interface LoggingConfig {
  readonly level: LogLevel;
  readonly pretty: boolean;
}

export interface SecurityConfig {
  readonly allowedOrigins: readonly string[];
  readonly bodyLimitBytes: number;
}

export interface SessionConfig {
  readonly secret: string;
  readonly ttlSeconds: number;
}

export interface ProjectConfig {
  readonly expiryDays: number;
  /** Absolute origin of the web application, used to build recovery links. */
  readonly webPublicUrl: string;
}

export type StorageAdapterName = 'filesystem' | 's3';
export type MalwareScannerName = 'clamav' | 'none' | 'reject';
export type AiProviderName = 'disabled' | 'ollama' | 'local-openai-compatible' | 'deterministic';

export interface S3Config {
  readonly endpoint: string;
  readonly port: number;
  readonly useSsl: boolean;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  readonly signedUrlTtlSeconds: number;
}

export interface MalwareConfig {
  readonly scanner: MalwareScannerName;
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  /** Production is always fail-closed, whatever this says. */
  readonly failClosed: boolean;
}

export interface AiConfig {
  readonly provider: AiProviderName;
  readonly baseUrl: string;
  /** Profile id, resolved against the model-profile registry. */
  readonly modelProfile: string;
  /** Overrides the profile's model name. Empty means "use the profile's". */
  readonly modelOverride: string;
  readonly requestTimeoutMs: number;
  readonly runTimeoutMs: number;
  /** 0 means "use the profile's value". */
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly maxAttempts: number;
  /** Whether production refuses a loopback endpoint as well as a public one. */
  readonly requireRemoteEndpoint: boolean;
  /** Built-in behaviour for the deterministic test provider. Empty means none. */
  readonly deterministicScenario: '' | 'echo';
}

export interface UploadConfig {
  readonly adapter: StorageAdapterName;
  readonly storageRoot: string;
  readonly maxFileBytes: number;
  readonly maxProjectBytes: number;
  readonly maxFilesPerProject: number;
  readonly maxFilesPerRequest: number;
  readonly maxFilenameLength: number;
}

export interface ExtractionConfig {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly pollIntervalMs: number;
  readonly claimTimeoutMs: number;
  readonly workerEnabled: boolean;
  readonly maxBlocks: number;
  readonly maxRows: number;
  readonly maxPages: number;
  readonly maxUncompressedBytes: number;
}

export interface OcrConfig {
  readonly enabled: boolean;
  readonly binary: string;
  readonly languages: string;
  readonly timeoutMs: number;
  readonly minConfidence: number;
}

export interface LegacyConversionConfig {
  readonly enabled: boolean;
  readonly binary: string;
  readonly timeoutMs: number;
}

/**
 * Typed, grouped access to validated configuration.
 *
 * This service — and the module that builds it — is the only place in the API
 * that is allowed to touch the process environment. Everything else injects this
 * service, which keeps configuration testable and makes it impossible for a
 * feature module to depend on an undocumented variable.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<ApiEnvironment, true>) {}

  get nodeEnv(): NodeEnvironment {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get server(): ServerConfig {
    return {
      port: this.config.get('API_PORT', { infer: true }),
      host: this.config.get('API_HOST', { infer: true }),
      publicUrl: this.config.get('API_PUBLIC_URL', { infer: true }),
    };
  }

  get database(): DatabaseConfig {
    return {
      uri: this.config.get('MONGODB_URI', { infer: true }),
      connectTimeoutMs: this.config.get('MONGODB_CONNECT_TIMEOUT_MS', { infer: true }),
    };
  }

  get logging(): LoggingConfig {
    return {
      level: this.config.get('LOG_LEVEL', { infer: true }),
      // Pretty printing is a development affordance; it is never worth the
      // throughput cost or the loss of machine-parseable output in production.
      pretty: this.config.get('LOG_PRETTY', { infer: true }) && !this.isProduction,
    };
  }

  get security(): SecurityConfig {
    return {
      allowedOrigins: this.config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
      bodyLimitBytes: this.config.get('REQUEST_BODY_LIMIT_BYTES', { infer: true }),
    };
  }

  get session(): SessionConfig {
    return {
      secret: this.config.get('PROJECT_SESSION_SECRET', { infer: true }),
      ttlSeconds: this.config.get('PROJECT_SESSION_TTL_SECONDS', { infer: true }),
    };
  }

  get project(): ProjectConfig {
    return {
      expiryDays: this.config.get('PROJECT_EXPIRY_DAYS', { infer: true }),
      webPublicUrl: this.config.get('WEB_PUBLIC_URL', { infer: true }),
    };
  }

  get upload(): UploadConfig {
    return {
      adapter: this.config.get('STORAGE_ADAPTER', { infer: true }),
      storageRoot: this.config.get('UPLOAD_STORAGE_ROOT', { infer: true }),
      maxFileBytes: this.config.get('UPLOAD_MAX_FILE_BYTES', { infer: true }),
      maxProjectBytes: this.config.get('UPLOAD_MAX_PROJECT_BYTES', { infer: true }),
      maxFilesPerProject: this.config.get('UPLOAD_MAX_FILES_PER_PROJECT', { infer: true }),
      maxFilesPerRequest: this.config.get('UPLOAD_MAX_FILES_PER_REQUEST', { infer: true }),
      maxFilenameLength: this.config.get('UPLOAD_MAX_FILENAME_LENGTH', { infer: true }),
    };
  }

  get extraction(): ExtractionConfig {
    return {
      timeoutMs: this.config.get('EXTRACTION_TIMEOUT_MS', { infer: true }),
      maxAttempts: this.config.get('EXTRACTION_MAX_ATTEMPTS', { infer: true }),
      retryBackoffMs: this.config.get('EXTRACTION_RETRY_BACKOFF_MS', { infer: true }),
      pollIntervalMs: this.config.get('EXTRACTION_POLL_INTERVAL_MS', { infer: true }),
      claimTimeoutMs: this.config.get('EXTRACTION_CLAIM_TIMEOUT_MS', { infer: true }),
      workerEnabled: this.config.get('EXTRACTION_WORKER_ENABLED', { infer: true }),
      maxBlocks: this.config.get('EXTRACTION_MAX_BLOCKS', { infer: true }),
      maxRows: this.config.get('EXTRACTION_MAX_ROWS', { infer: true }),
      maxPages: this.config.get('EXTRACTION_MAX_PAGES', { infer: true }),
      maxUncompressedBytes: this.config.get('EXTRACTION_MAX_UNCOMPRESSED_BYTES', { infer: true }),
    };
  }

  get ocr(): OcrConfig {
    return {
      enabled: this.config.get('OCR_ENABLED', { infer: true }),
      binary: this.config.get('OCR_TESSERACT_BINARY', { infer: true }),
      languages: this.config.get('OCR_LANGUAGES', { infer: true }),
      timeoutMs: this.config.get('OCR_TIMEOUT_MS', { infer: true }),
      minConfidence: this.config.get('OCR_MIN_CONFIDENCE', { infer: true }),
    };
  }

  get legacyConversion(): LegacyConversionConfig {
    return {
      enabled: this.config.get('LEGACY_CONVERSION_ENABLED', { infer: true }),
      binary: this.config.get('LEGACY_CONVERSION_BINARY', { infer: true }),
      timeoutMs: this.config.get('LEGACY_CONVERSION_TIMEOUT_MS', { infer: true }),
    };
  }

  get s3(): S3Config {
    return {
      endpoint: this.config.get('S3_ENDPOINT', { infer: true }),
      port: this.config.get('S3_PORT', { infer: true }),
      useSsl: this.config.get('S3_USE_SSL', { infer: true }),
      bucket: this.config.get('S3_BUCKET', { infer: true }),
      accessKey: this.config.get('S3_ACCESS_KEY', { infer: true }),
      secretKey: this.config.get('S3_SECRET_KEY', { infer: true }),
      region: this.config.get('S3_REGION', { infer: true }),
      signedUrlTtlSeconds: this.config.get('S3_SIGNED_URL_TTL_SECONDS', { infer: true }),
    };
  }

  get malware(): MalwareConfig {
    return {
      scanner: this.config.get('MALWARE_SCANNER', { infer: true }),
      host: this.config.get('CLAMAV_HOST', { infer: true }),
      port: this.config.get('CLAMAV_PORT', { infer: true }),
      timeoutMs: this.config.get('CLAMAV_TIMEOUT_MS', { infer: true }),
      // Production ignores the flag: an unreachable scanner must never become a
      // silent bypass on the one deployment where it matters.
      failClosed: this.isProduction || this.config.get('MALWARE_FAIL_CLOSED', { infer: true }),
    };
  }

  get ai(): AiConfig {
    return {
      provider: this.config.get('AI_PROVIDER', { infer: true }),
      baseUrl: this.config.get('AI_BASE_URL', { infer: true }),
      modelProfile: this.config.get('AI_MODEL_PROFILE', { infer: true }),
      modelOverride: this.config.get('AI_MODEL', { infer: true }),
      requestTimeoutMs: this.config.get('AI_REQUEST_TIMEOUT_MS', { infer: true }),
      runTimeoutMs: this.config.get('AI_RUN_TIMEOUT_MS', { infer: true }),
      maxContextTokens: this.config.get('AI_MAX_CONTEXT_TOKENS', { infer: true }),
      maxOutputTokens: this.config.get('AI_MAX_OUTPUT_TOKENS', { infer: true }),
      maxAttempts: this.config.get('AI_MAX_ATTEMPTS', { infer: true }),
      requireRemoteEndpoint: this.config.get('AI_REQUIRE_REMOTE_ENDPOINT', { infer: true }),
      deterministicScenario: this.config.get('AI_DETERMINISTIC_SCENARIO', { infer: true }),
    };
  }

  get openApiEnabled(): boolean {
    return this.config.get('OPENAPI_ENABLED', { infer: true });
  }
}
