import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  PROJECT_ROUTES,
  REQUIREMENT_ROUTES,
  UPLOAD_FIELD_NAME,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { ExtractionWorker } from '../src/requirements/queue/extraction.worker';
import { configureSecurity } from '../src/security';

/**
 * The ingestion pipeline over HTTP, shared by the two suites that exercise it.
 *
 * Two suites, because PDF extraction runs in its own Jest project and therefore
 * its own process — see `jest.pdf.config.ts` for why. This module is what keeps
 * that split from duplicating the bootstrap and the upload helpers.
 *
 * Not named `*.e2e-spec.ts`, so neither project picks it up as a test file.
 */

export interface IngestionSession {
  readonly agent: ReturnType<typeof request.agent>;
  readonly csrf: string;
  readonly projectId: string;
}

export interface IngestionHarness {
  readonly app: NestExpressApplication;
  readonly worker: ExtractionWorker;
  /** Reads a binary fixture from `test/fixtures`. */
  fixture(name: string): Buffer;
  /** A fresh browser holding a session for a brand-new project. */
  newProject(name?: string): Promise<IngestionSession>;
  uploadFixture(
    session: IngestionSession,
    name: string,
    as?: string,
    mimeType?: string,
  ): Promise<request.Response>;
  /** Runs queued jobs to completion. Bounded, so a bug cannot hang the suite. */
  drainWorker(maximum?: number): Promise<void>;
  /**
   * Uploads a fixture and waits for that source to reach a settled status.
   *
   * `source` is the response body, deliberately as loosely typed as supertest
   * gives it: these tests assert on the wire shape a browser would receive, not
   * on our own view types.
   */
  uploadAndExtract(
    name: string,
    as?: string,
  ): Promise<{ session: IngestionSession; sourceId: string; source: request.Response['body'] }>;
  close(): Promise<void>;
}

const FIXTURES = join(__dirname, 'fixtures');

/**
 * Boots the real application.
 *
 * The worker is driven explicitly rather than left to its poll timer. A test
 * that uploads and then sleeps is a test that passes on a fast machine and
 * fails on a loaded one; `drainWorker` makes "the file has been read" a fact
 * rather than a hope.
 */
export async function startIngestionHarness(): Promise<IngestionHarness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  configureSecurity(app, app.get(AppConfigService));
  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
  await app.init();

  const worker = app.get(ExtractionWorker);
  const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

  const drainWorker = async (maximum = 20): Promise<void> => {
    for (let index = 0; index < maximum; index += 1) {
      if (!(await worker.runOnce())) {
        return;
      }
    }
  };

  const newProject = async (name = 'Ingestion test'): Promise<IngestionSession> => {
    const agent = request.agent(app.getHttpServer());
    const created = await agent.post(PROJECT_ROUTES.create).send({ name }).expect(201);

    const raw: unknown = created.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
    const csrf = cookies
      .find((value) => value.startsWith(CSRF_COOKIE))
      ?.split(';')[0]
      ?.split('=')[1];

    return { agent, csrf: csrf ?? '', projectId: created.body.project.projectId as string };
  };

  const uploadFixture = async (
    session: IngestionSession,
    name: string,
    as = name,
    mimeType?: string,
  ): Promise<request.Response> =>
    session.agent
      .post(REQUIREMENT_ROUTES.uploads)
      .set('x-csrf-token', session.csrf)
      .attach(UPLOAD_FIELD_NAME, fixture(name), {
        filename: as,
        ...(mimeType ? { contentType: mimeType } : {}),
      });

  /*
   * Waits on the *source* rather than on the queue reporting empty: a job can be
   * claimed and still running when `runOnce` next reports nothing to do, and the
   * test then asserts against a source that is mid-extraction. That produced a
   * failure that looked like a broken extractor and was really a race — and it
   * only showed up once more suites shared the database. Bounded, so a genuine
   * hang still fails rather than spins.
   */
  const uploadAndExtract = async (
    name: string,
    as = name,
  ): Promise<{
    session: IngestionSession;
    sourceId: string;
    source: request.Response['body'];
  }> => {
    const session = await newProject();
    const upload = await uploadFixture(session, name, as);
    const sourceId = upload.body.outcomes[0].source.sourceId as string;
    const settled = ['READY', 'REVIEW_REQUIRED', 'FAILED', 'OCR_REQUIRED'];

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await drainWorker();

      const current = await session.agent.get(REQUIREMENT_ROUTES.source(sourceId)).expect(200);

      if (settled.includes(current.body.status as string)) {
        return { session, sourceId, source: current.body };
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const source = await session.agent.get(REQUIREMENT_ROUTES.source(sourceId)).expect(200);
    return { session, sourceId, source: source.body };
  };

  return {
    app,
    worker,
    fixture,
    newProject,
    uploadFixture,
    drainWorker,
    uploadAndExtract,
    close: async () => {
      await app.close();
    },
  };
}
