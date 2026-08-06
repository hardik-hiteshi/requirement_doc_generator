import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CORRELATION_ID_HEADER } from '@wdrg/contracts';
import cookieParser from 'cookie-parser';
import helmet, { type HelmetOptions } from 'helmet';

import type { AppConfigService } from './config';

/**
 * Builds the helmet options for an environment.
 *
 * Extracted from `main.ts` so the security posture is testable rather than
 * asserted in a document — `security.spec.ts` applies these to a real Nest
 * application and inspects the response headers over HTTP.
 *
 * ## Content-Security-Policy
 *
 * `contentSecurityPolicy: undefined` leaves helmet's **default** policy in
 * place; `false` disables the header entirely. So:
 *
 * - **production** — helmet's default CSP is sent. It is a generic
 *   `default-src 'self'` policy, appropriate for a JSON API that serves no
 *   markup of its own and correct for every route except the Swagger UI.
 * - **non-production** — no CSP. Helmet's default blocks the inline scripts and
 *   styles the Swagger UI needs, and the interactive documentation is a
 *   development tool.
 *
 * This is deliberately *not* an application-specific policy. A tailored CSP for
 * the web application — which needs the runtime origins of object storage,
 * CAPTCHA and any analytics before it can be written without being disabled at
 * the first breakage — is Phase 12 work.
 */
export function buildHelmetOptions(config: AppConfigService): HelmetOptions {
  return {
    // undefined => helmet's default CSP; false => header omitted.
    contentSecurityPolicy: config.isProduction ? undefined : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  };
}

/**
 * Applies transport-level hardening and CORS.
 *
 * Order matters: this runs before routing so that a request rejected for its
 * body size or origin still carries the security headers.
 */
export function configureSecurity(app: NestExpressApplication, config: AppConfigService): void {
  app.use(helmet(buildHelmetOptions(config)));

  // Parses the project session and CSRF cookies. Unsigned deliberately: the
  // session cookie carries its own HMAC (see ProjectSessionService), so
  // cookie-parser's signing would be a second, weaker mechanism doing the same
  // job with a different secret.
  app.use(cookieParser());

  app.useBodyParser('json', { limit: config.security.bodyLimitBytes });
  app.useBodyParser('urlencoded', {
    limit: config.security.bodyLimitBytes,
    extended: true,
  });

  configureCors(app, config);
}

/**
 * Separated so a test harness that does not use the Express body parser can
 * still exercise the CORS contract.
 */
export function configureCors(app: INestApplication, config: AppConfigService): void {
  app.enableCors({
    origin: [...config.security.allowedOrigins],
    credentials: true,
    // Without this the browser cannot read the correlation id, which defeats
    // the point of returning it.
    exposedHeaders: [CORRELATION_ID_HEADER],
  });
}
