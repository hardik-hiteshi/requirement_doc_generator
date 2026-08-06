import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_VERSION, OPENAPI_JSON_PATH, OPENAPI_PATH } from '@wdrg/contracts';

import { API_SERVICE_VERSION } from './app.constants';
import type { AppConfigService } from './config';

/**
 * Publishes the OpenAPI document.
 *
 * Serving is configuration-driven: useful everywhere during development, and
 * something an operator can switch off in production without a code change.
 */
export function setupOpenApi(app: INestApplication, config: AppConfigService): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Requirement Documentation Generator API')
      .setDescription(
        [
          'Converts client requirements into an approved baseline, effort estimation,',
          'technology-stack decision and seven project documents.',
          '',
          'Every error response uses the same envelope and carries an `x-correlation-id`',
          'header matching the `error.correlationId` field, so a reported failure can be',
          'traced to its structured log lines.',
        ].join('\n'),
      )
      .setVersion(API_SERVICE_VERSION)
      .addServer(config.server.publicUrl)
      .addTag('health', 'Liveness and readiness probes')
      .build(),
    {
      operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
    },
  );

  SwaggerModule.setup(OPENAPI_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
    customSiteTitle: `Requirement Generator API v${API_VERSION}`,
  });
}
