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

  it('lists all seven documents, every one of them implemented', async () => {
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
    /* Phases 7, 8 and 9 between them built all seven. */
    expect(documents.filter((document) => document.implemented)).toHaveLength(7);

    /* Nothing is unlocked yet: there is no approved baseline. */
    for (const document of documents) {
      expect(document.status).toBe('NOT_STARTED');
      expect(document.lock).not.toBeNull();
    }

    /*
     * With no approved baseline, the missing upstream artifact is the honest reason —
     * it outranks the sequence, because telling somebody to approve a statement of
     * work when they have not analysed any requirements yet would send them nowhere.
     */
    expect(
      documents.find((document) => document.type === 'WORK_BREAKDOWN_STRUCTURE')?.lock?.reason,
    ).toBe('upstream_missing');
    expect(documents.find((document) => document.type === 'OUR_UNDERSTANDING')?.lock?.reason).toBe(
      'upstream_missing',
    );
  });

  it('refuses to generate a document whose prerequisites are not approved', async () => {
    /*
     * Was a not-implemented refusal until Phase 9 built this document. The refusal is
     * still a refusal — what changed is the reason, from "does not exist" to "the step
     * before it has not been approved", which is the honest one.
     */
    const { agent, csrf } = await session();

    const response = await agent
      .post(DOCUMENT_ROUTES.generate('WORK_BREAKDOWN_STRUCTURE'))
      .set('x-csrf-token', csrf)
      .send({ useAi: false, expectedVersion: 0 })
      .expect(422);

    expect(JSON.stringify(response.body)).toContain('DOCUMENT_LOCKED');
  });

  it('refuses every route without a session', async () => {
    const anonymous = request.agent(app.getHttpServer());

    await anonymous.get(DOCUMENT_ROUTES.documents).expect(401);
    await anonymous.get(DOCUMENT_ROUTES.document('OUR_UNDERSTANDING')).expect(401);
  });
});
