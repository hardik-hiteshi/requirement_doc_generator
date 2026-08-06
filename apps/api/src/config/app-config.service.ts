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

  get openApiEnabled(): boolean {
    return this.config.get('OPENAPI_ENABLED', { infer: true });
  }
}
