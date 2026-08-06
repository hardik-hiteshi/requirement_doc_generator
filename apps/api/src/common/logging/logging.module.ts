import { Module } from '@nestjs/common';
import { HEALTH_ROUTES } from '@wdrg/contracts';
import { LoggerModule } from 'nestjs-pino';

import { AppConfigModule, AppConfigService } from '../../config';
import { createRequestIdFactory } from './correlation-id';

/**
 * Structured JSON logging for the whole application.
 *
 * Every line carries the request's correlation id, so a support request quoting
 * the id from an error response resolves to the exact request. Sensitive headers
 * are redacted at the logger rather than at each call site — a call site that
 * forgets is a leak, a redaction list that forgets is a visible gap.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logging.level,
          genReqId: createRequestIdFactory(),
          autoLogging: {
            // Probes run every few seconds; logging them buries real traffic.
            ignore: (request) =>
              request.url === HEALTH_ROUTES.liveness || request.url === HEALTH_ROUTES.readiness,
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.headers["proxy-authorization"]',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
          customProps: () => ({ service: 'api' }),
          ...(config.logging.pretty
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
                },
              }
            : {}),
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
