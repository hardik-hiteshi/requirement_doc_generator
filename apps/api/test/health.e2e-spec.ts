import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  API_PREFIX,
  API_VERSION,
  CORRELATION_ID_HEADER,
  HEALTH_ROUTES,
  apiErrorResponseSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { setupOpenApi } from '../src/openapi';

/**
 * Boots the real application over HTTP.
 *
 * Requires a reachable MongoDB — `pnpm docker:up` locally, a service container in
 * CI. Run with `pnpm --filter @wdrg/api test:e2e`.
 */
describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    setupOpenApi(app, app.get(AppConfigService));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('liveness', () => {
    it('answers 200 with a contract-shaped payload', async () => {
      const response = await request(app.getHttpServer()).get(HEALTH_ROUTES.liveness).expect(200);

      expect(livenessResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.status).toBe('ok');
    });

    it('is reachable without a version segment', async () => {
      await request(app.getHttpServer()).get('/api/health/live').expect(200);
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(404);
    });
  });

  describe('readiness', () => {
    it('reports MongoDB as up when the database is reachable', async () => {
      const response = await request(app.getHttpServer()).get(HEALTH_ROUTES.readiness).expect(200);

      expect(readinessResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.details.mongodb.status).toBe('up');
    });
  });

  describe('correlation ids', () => {
    it('returns one on every response', async () => {
      const response = await request(app.getHttpServer()).get(HEALTH_ROUTES.liveness);

      expect(response.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(response.headers[CORRELATION_ID_HEADER]).not.toHaveLength(0);
    });

    it('echoes a caller-supplied id', async () => {
      const response = await request(app.getHttpServer())
        .get(HEALTH_ROUTES.liveness)
        .set('x-request-id', 'e2e-trace-001');

      expect(response.headers[CORRELATION_ID_HEADER]).toBe('e2e-trace-001');
    });

    it('replaces an unsafe id rather than echoing it', async () => {
      const response = await request(app.getHttpServer())
        .get(HEALTH_ROUTES.liveness)
        .set('x-request-id', 'bad id with spaces');

      expect(response.headers[CORRELATION_ID_HEADER]).not.toBe('bad id with spaces');
    });
  });

  describe('error envelope', () => {
    it('returns the standard shape for an unknown route', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      expect(apiErrorResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.path).toBe('/api/v1/does-not-exist');
    });

    it('matches the response envelope to the correlation id header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/does-not-exist')
        .set('x-request-id', 'e2e-error-002');

      expect(response.body.error.correlationId).toBe('e2e-error-002');
      expect(response.headers[CORRELATION_ID_HEADER]).toBe('e2e-error-002');
    });

    it('never includes a stack trace', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist');

      expect(JSON.stringify(response.body)).not.toContain('stack');
    });
  });

  describe('openapi', () => {
    it('serves a valid document describing the health routes', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);

      expect(response.body.openapi).toMatch(/^3\./);
      expect(response.body.paths[HEALTH_ROUTES.liveness]).toBeDefined();
      expect(response.body.paths[HEALTH_ROUTES.readiness]).toBeDefined();
    });
  });
});
