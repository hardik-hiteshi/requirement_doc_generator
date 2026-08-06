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

export interface UploadConfig {
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

  get malwareScanner(): 'none' | 'reject' {
    return this.config.get('MALWARE_SCANNER', { infer: true });
  }

  get openApiEnabled(): boolean {
    return this.config.get('OPENAPI_ENABLED', { infer: true });
  }
}
