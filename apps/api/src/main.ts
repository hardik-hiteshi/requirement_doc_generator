import 'reflect-metadata';

import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX, API_VERSION, OPENAPI_PATH } from '@wdrg/contracts';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AppConfigService } from './config';
import {
  checkProductionPolicy,
  describeAdvisories,
  describeViolations,
  productionAdvisories,
} from './config/production-policy';
import { setupOpenApi } from './openapi';
import { configureSecurity } from './security';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer until the pino logger is resolved, so startup lines are structured
    // too — including any configuration validation failure.
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  const config = app.get(AppConfigService);

  /*
   * Refuse to start a production deployment that is configured unsafely.
   *
   * Checked here, before anything listens, because the alternative is a process
   * that boots cleanly and accepts unscanned uploads. Every problem is reported
   * together — a deployment fixing three should learn about all three at once.
   */
  const violations = checkProductionPolicy(config);

  if (violations.length > 0) {
    const logger = app.get(Logger);
    logger.error(describeViolations(violations));
    await app.close();
    process.exitCode = 1;
    return;
  }

  /*
   * Choices that are consequential rather than wrong: logged, not fatal. Refusing to
   * start over a lawful data-retention policy would be the tool overruling its
   * operator — see `productionAdvisories`.
   */
  const advisories = productionAdvisories(config);

  if (advisories.length > 0) {
    app.get(Logger).warn(describeAdvisories(advisories));
  }

  // Transport hardening: helmet, body limits and CORS. Defined in ./security so
  // the same configuration the process runs is the configuration the header
  // tests assert against.
  configureSecurity(app, config);

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: API_VERSION,
  });

  // Runs onModuleDestroy hooks on SIGTERM so in-flight work finishes and the
  // Mongo connection closes cleanly on a rolling deploy.
  app.enableShutdownHooks();

  if (config.openApiEnabled) {
    setupOpenApi(app, config);
  }

  await app.listen(config.server.port, config.server.host);

  const logger = app.get(Logger);
  logger.log(
    {
      port: config.server.port,
      host: config.server.host,
      environment: config.nodeEnv,
      openApi: config.openApiEnabled ? `${config.server.publicUrl}${OPENAPI_PATH}` : 'disabled',
    },
    'API started',
  );
}

void bootstrap();
