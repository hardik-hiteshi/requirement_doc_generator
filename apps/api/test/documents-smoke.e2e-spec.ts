import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  DOCUMENT_ROUTES,
  PROJECT_ROUTES,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { configureSecurity } from '../src/security';

/**
 * The documents step boots and answers, before anything is generated.
 *
 * A deliberately small suite. The full behaviour lives in
 * `documents.e2e-spec.ts`, which needs an approved baseline, a locked stack and
 * an approved estimate; this one exists so a wiring mistake — a missing provider,
 * a circular module import, a schema Mongoose rejects — fails in two seconds
 * rather than three minutes into the long one.
 */
describe('Documents wiring (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureSecurity(app, app.get(AppConfigService));
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function session() {
    const agent = request.agent(app.getHttpServer());
    const created = await agent.post(PROJECT_ROUTES.create).send({ name: 'Documents' }).expect(201);

    const raw: unknown = created.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
    const csrf =
      cookies
        .find((value) => value.startsWith(CSRF_COOKIE))
        ?.split(';')[0]
        ?.split('=')[1] ?? '';

    return { agent, csrf };
  }

  it('lists all seven documents, with five marked unavailable', async () => {
    const { agent } = await session();
    const response = await agent.get(DOCUMENT_ROUTES.documents).expect(200);

    const documents = response.body.documents as {
      type: string;
      implemented: boolean;
      status: string;
      lock: { reason: string } | null;
    }[];

    expect(documents).toHaveLength(7);
    expect(documents.map((document) => document.type).slice(0, 2)).toEqual([
      'OUR_UNDERSTANDING',
      'FEATURE_LISTING',
    ]);
    expect(documents.filter((document) => document.implemented)).toHaveLength(2);
    expect(documents.filter((document) => !document.implemented)).toHaveLength(5);

    /* Nothing is unlocked yet: there is no approved baseline. */
    for (const document of documents) {
      expect(document.status).toBe('NOT_STARTED');
      expect(document.lock).not.toBeNull();
    }

    expect(documents.find((document) => document.type === 'STATEMENT_OF_WORK')?.lock?.reason).toBe(
      'not_implemented',
    );
    expect(documents.find((document) => document.type === 'OUR_UNDERSTANDING')?.lock?.reason).toBe(
      'upstream_missing',
    );
  });

  it('refuses to generate a document that is not implemented', async () => {
    const { agent, csrf } = await session();

    const response = await agent
      .post(DOCUMENT_ROUTES.generate('STATEMENT_OF_WORK'))
      .set('x-csrf-token', csrf)
      .send({ useAi: false, expectedVersion: 0 })
      .expect(422);

    expect(JSON.stringify(response.body)).toContain('DOCUMENT_NOT_IMPLEMENTED');
  });

  it('refuses every route without a session', async () => {
    const anonymous = request.agent(app.getHttpServer());

    await anonymous.get(DOCUMENT_ROUTES.documents).expect(401);
    await anonymous.get(DOCUMENT_ROUTES.document('OUR_UNDERSTANDING')).expect(401);
  });
});
