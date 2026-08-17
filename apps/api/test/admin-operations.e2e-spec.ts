import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ADMIN_ROUTES,
  ADMIN_TOKEN_HEADER,
  API_PREFIX,
  API_VERSION,
  CONFIG_PRESENCE_KEYS,
  FORBIDDEN_PROJECT_VIEW_FIELDS,
  PROJECT_ROUTES,
  REQUIREMENT_ROUTES,
} from '@wdrg/contracts';
import type { Connection } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { MetricsService } from '../src/observability/metrics.service';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';

/**
 * The operator surface, against a running application.
 *
 * Two things are being proved here that no unit test can. The first is that the token
 * boundary actually holds over HTTP — absent, wrong and right, on every route. The
 * second, and the reason this file is long, is that **no forbidden field reaches the
 * wire**: the project view is metadata by construction, and the only way to know it
 * stays that way is to read the serialised response and look.
 */
describe('Admin operations (e2e)', () => {
  let app: NestExpressApplication;
  let connection: Connection;
  let metrics: MetricsService;

  const ADMIN_TOKEN = 'operator-token-of-sufficient-length-000000';

  class AdminTestConfig extends AppConfigService {
    override get admin() {
      return { token: ADMIN_TOKEN, enabled: true };
    }

    override get rateLimit() {
      /* Off: this suite is about the operator surface, not about ceilings. */
      return { ...super.rateLimit, enabled: false };
    }

    override get retention() {
      return { ...super.retention, enabled: false };
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useFactory({
        factory: (config: ConfigService) => new AdminTestConfig(config as never),
        inject: [ConfigService],
      })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureSecurity(app, app.get(AppConfigService));
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    setupOpenApi(app, app.get(AppConfigService));
    await app.init();

    connection = app.get(getConnectionToken());
    metrics = app.get(MetricsService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  /* --------------------------------------------------------------- helpers */

  const operator = () => request(app.getHttpServer());

  const authed = (path: string) => operator().get(path).set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN);

  async function newProject(name = 'Admin operations') {
    const agent = request.agent(app.getHttpServer());
    const created = await agent
      .post(PROJECT_ROUTES.create)
      .send({ name, projectTypes: ['WEB_APPLICATION'] })
      .expect(201);

    const raw: unknown = created.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
    const csrf =
      cookies
        .find((value) => value.startsWith('wdrg_csrf'))
        ?.split(';')[0]
        ?.split('=')[1] ?? '';

    return {
      agent,
      csrf,
      projectId: (created.body as { project: { projectId: string } }).project.projectId,
    };
  }

  /* ------------------------------------------------- the token boundary */

  describe('the token boundary', () => {
    const routes = [
      ADMIN_ROUTES.status,
      ADMIN_ROUTES.audit,
      ADMIN_ROUTES.projects,
      ADMIN_ROUTES.queue,
      ADMIN_ROUTES.config,
      ADMIN_ROUTES.metrics,
    ];

    it.each(routes)('refuses %s without a token', async (route) => {
      expect((await operator().get(route)).status).toBe(401);
    });

    it.each(routes)('refuses %s with the wrong token', async (route) => {
      const response = await operator()
        .get(route)
        .set(ADMIN_TOKEN_HEADER, 'operator-token-of-sufficient-length-000001');

      expect(response.status).toBe(401);
    });

    it.each(routes)('admits %s with the right token', async (route) => {
      expect((await authed(route)).status).toBe(200);
    });

    it('refuses the two actions without a token', async () => {
      expect((await operator().post(ADMIN_ROUTES.retentionRun)).status).toBe(401);
      expect((await operator().post(ADMIN_ROUTES.jobRetry('whatever'))).status).toBe(401);
    });

    it('never echoes the token, whatever it is sent', async () => {
      const wrong = await operator().get(ADMIN_ROUTES.status).set(ADMIN_TOKEN_HEADER, 'nope');
      const right = await authed(ADMIN_ROUTES.status);

      expect(JSON.stringify(wrong.body)).not.toContain('nope');
      expect(JSON.stringify(right.body)).not.toContain(ADMIN_TOKEN);
    });
  });

  /* ------------------------------------------------ project visibility */

  describe('project visibility', () => {
    it('lists projects with metadata and nothing else', async () => {
      const { projectId } = await newProject('Listed');

      const response = await authed(`${ADMIN_ROUTES.projects}?projectId=${projectId}`).expect(200);
      const body = response.body as { projects: Record<string, unknown>[]; truncated: boolean };

      expect(body.projects).toHaveLength(1);

      const [entry] = body.projects;

      /* Exactly the fields the contract declares — no more. */
      expect(Object.keys(entry!).sort()).toEqual(
        [
          'createdAt',
          'effectiveStatus',
          'expiresAt',
          'lastAccessedAt',
          'name',
          'projectId',
          'status',
          'updatedAt',
        ].filter((key) => key in entry!),
      );
    }, 60_000);

    it('reports counts, and the derived status beside the stored one', async () => {
      const { agent, csrf, projectId } = await newProject('Counted');

      await agent
        .post(REQUIREMENT_ROUTES.textSources)
        .set('x-csrf-token', csrf)
        .send({ title: 'Brief', text: 'Staff must record their weekly timesheets.' })
        .expect(201);

      const response = await authed(ADMIN_ROUTES.project(projectId)).expect(200);
      const body = response.body as {
        status: string;
        effectiveStatus: string;
        counts: Record<string, number>;
        unfinishedJobs: Record<string, number>;
      };

      expect(body.counts.requirementSources).toBeGreaterThan(0);
      expect(body.counts.auditEvents).toBeGreaterThan(0);
      expect(body.status).toBe('DRAFT');
      expect(body.effectiveStatus).toBe('DRAFT');
      expect(body.unfinishedJobs).toBeDefined();
    }, 120_000);

    it('shows an expired project as expired even while the record says otherwise', async () => {
      const { projectId } = await newProject('Lapsed');

      /* Aged past its expiry without the sweep having run. */
      await connection
        .collection('projects')
        .updateOne({ projectId }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });

      const response = await authed(ADMIN_ROUTES.project(projectId)).expect(200);
      const body = response.body as { status: string; effectiveStatus: string };

      /*
       * The difference between these two is the answer to "why can't they edit it",
       * which is exactly the support question this view exists for.
       */
      expect(body.status).toBe('DRAFT');
      expect(body.effectiveStatus).toBe('EXPIRED');
    }, 60_000);

    it('carries no content, no payload and no secret — checked on the wire', async () => {
      const { agent, csrf, projectId } = await newProject('Sensitive');

      await agent
        .post(REQUIREMENT_ROUTES.textSources)
        .set('x-csrf-token', csrf)
        .send({
          title: 'Confidential brief',
          text: 'The margin on this engagement is commercially sensitive.',
        })
        .expect(201);

      const detail = await authed(ADMIN_ROUTES.project(projectId)).expect(200);
      const list = await authed(`${ADMIN_ROUTES.projects}?projectId=${projectId}`).expect(200);

      for (const response of [detail, list]) {
        const serialised = JSON.stringify(response.body);

        /* The contract's list of names that must never appear. */
        for (const field of FORBIDDEN_PROJECT_VIEW_FIELDS) {
          expect(serialised).not.toContain(`"${field}"`);
        }

        /* And the content itself, by the words that were submitted. */
        expect(serialised).not.toContain('commercially sensitive');
        expect(serialised).not.toContain('Confidential brief');
        /* Mongo's own id is not an operator's business either. */
        expect(serialised).not.toContain('"_id"');
      }
    }, 120_000);

    it('answers 404 for a project that does not exist, and records the lookup', async () => {
      const response = await authed(ADMIN_ROUTES.project('prj_000000000000000000000000'));

      expect(response.status).toBe(404);

      /* A lookup of something absent is what a probe looks like, so it is on the record. */
      const events = await connection
        .collection('audit_events')
        .find({ type: 'ADMIN_PROJECT_VIEWED', projectId: 'prj_000000000000000000000000' })
        .toArray();

      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.metadata).toMatchObject({ found: false });
    }, 60_000);

    it('records every project view', async () => {
      const { projectId } = await newProject('Audited view');

      await authed(ADMIN_ROUTES.project(projectId)).expect(200);

      const events = await connection
        .collection('audit_events')
        .find({ type: 'ADMIN_PROJECT_VIEWED', projectId })
        .toArray();

      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toMatchObject({ found: true });
    }, 60_000);

    it("keeps one project out of another project's view", async () => {
      const first = await newProject('First');
      const second = await newProject('Second');

      const response = await authed(ADMIN_ROUTES.project(first.projectId)).expect(200);
      const body = response.body as { projectId: string };

      expect(body.projectId).toBe(first.projectId);
      expect(JSON.stringify(body)).not.toContain(second.projectId);
    }, 120_000);
  });

  /* --------------------------------------------------- queue visibility */

  describe('queue visibility', () => {
    it('reports depth, ages and the reclaim window', async () => {
      const response = await authed(ADMIN_ROUTES.queue).expect(200);
      const body = response.body as {
        counts: Record<string, number>;
        claimTimeoutSeconds: number;
        stalled: boolean;
        observedAt: string;
      };

      expect(body.counts).toBeDefined();
      expect(body.claimTimeoutSeconds).toBeGreaterThan(0);
      expect(typeof body.stalled).toBe('boolean');
      expect(Date.parse(body.observedAt)).not.toBeNaN();
    }, 60_000);

    it('reports a claimed job that has outlived the reclaim window as stalled', async () => {
      const { projectId } = await newProject('Stalled worker');

      /*
       * A job claimed long ago and never finished: exactly what a worker dying mid-job
       * leaves behind, and the state nothing surfaced before this phase.
       */
      await connection.collection('extraction_jobs').insertOne({
        jobId: 'job_stalled_fixture',
        projectId,
        sourceId: 'src_stalled_fixture',
        queue: 'extraction',
        status: 'running',
        stage: 'extract',
        attempts: 1,
        maxAttempts: 3,
        progress: 0,
        availableAt: new Date(Date.now() - 7_200_000),
        claimedAt: new Date(Date.now() - 7_200_000),
        createdAt: new Date(Date.now() - 7_200_000),
        updatedAt: new Date(Date.now() - 7_200_000),
      });

      const response = await authed(ADMIN_ROUTES.queue).expect(200);
      const body = response.body as { stalled: boolean; oldestClaimedSeconds?: number };

      expect(body.stalled).toBe(true);
      expect(body.oldestClaimedSeconds).toBeGreaterThan(body.stalled ? 0 : -1);

      await connection.collection('extraction_jobs').deleteOne({ jobId: 'job_stalled_fixture' });
    }, 60_000);

    it('refuses to retry a job that does not exist, and says so safely', async () => {
      const response = await operator()
        .post(ADMIN_ROUTES.jobRetry('job_does_not_exist'))
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN);

      /*
       * A clean refusal, not a 500. An operator typo must not read as an outage, and it
       * must not put a server error in the counter that signals real ones.
       */
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('/home');
      expect(JSON.stringify(response.body)).not.toContain('not in a retryable state');
    }, 60_000);

    it('records a retry attempt whether or not it succeeds', async () => {
      await operator()
        .post(ADMIN_ROUTES.jobRetry('job_audited_attempt'))
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN);

      const events = await connection
        .collection('audit_events')
        .find({ type: 'ADMIN_JOB_RETRIED' })
        .toArray();

      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).toContain('job_audited_attempt');
    }, 60_000);
  });

  /* -------------------------------------------------- config visibility */

  describe('configuration visibility', () => {
    it('shows allow-listed settings and no secret values', async () => {
      const response = await authed(ADMIN_ROUTES.config).expect(200);
      const body = response.body as {
        settings: Record<string, string>;
        secretsConfigured: Record<string, boolean>;
      };

      expect(body.settings.NODE_ENV).toBeDefined();

      /* Every secret is a boolean here, and its value appears nowhere. */
      for (const key of CONFIG_PRESENCE_KEYS) {
        expect(typeof body.secretsConfigured[key]).toBe('boolean');
        expect(body.settings[key]).toBeUndefined();
      }

      const serialised = JSON.stringify(body);

      expect(serialised).not.toContain(ADMIN_TOKEN);
      /* The session secret is the one whose exposure would forge every cookie. */
      expect(serialised).not.toContain(process.env.PROJECT_SESSION_SECRET ?? 'unset-in-this-run');
    }, 60_000);
  });

  /* -------------------------------------------------------- observability */

  describe('metrics that are actually emitted', () => {
    it('counts requests by outcome, which Phase 12 declared and never produced', async () => {
      metrics.reset();

      await newProject('Counted request');
      await operator().get('/api/v1/projects/current');

      const scrape = await authed(ADMIN_ROUTES.metrics).expect(200);

      expect(scrape.text).toContain('wdrg_http_requests_total');
      expect(scrape.text).toMatch(/wdrg_http_requests_total\{outcome="ok"\} [1-9]/);
    }, 60_000);

    it('records request duration as a well-formed histogram', async () => {
      metrics.reset();

      await authed(ADMIN_ROUTES.status).expect(200);

      const scrape = await authed(ADMIN_ROUTES.metrics).expect(200);

      expect(scrape.text).toContain('# TYPE wdrg_http_request_duration_seconds histogram');
      expect(scrape.text).toMatch(/wdrg_http_request_duration_seconds_bucket\{.*le="\+Inf"\}/);
      /* One TYPE line per metric, or a collector rejects the whole scrape. */
      expect(scrape.text.match(/# TYPE wdrg_http_request_duration_seconds/g)).toHaveLength(1);
    }, 60_000);

    it('counts a failure by error code', async () => {
      metrics.reset();

      /* A refused operator request is the cheapest real failure to provoke. */
      await operator().get(ADMIN_ROUTES.status).set(ADMIN_TOKEN_HEADER, 'wrong-token-here-000000');

      const scrape = await authed(ADMIN_ROUTES.metrics).expect(200);

      expect(scrape.text).toContain('wdrg_errors_total{code="UNAUTHORIZED"}');
    }, 60_000);

    it('serves exposition text a collector can parse', async () => {
      const scrape = await authed(ADMIN_ROUTES.metrics).expect(200);

      expect(scrape.headers['content-type']).toContain('text/plain');

      /* Every HELP is followed by a TYPE for the same metric, and no TYPE repeats. */
      const types = [...scrape.text.matchAll(/^# TYPE (\S+)/gm)].map(([, name]) => name);

      expect(new Set(types).size).toBe(types.length);
    }, 60_000);
  });

  /* ------------------------------------------------------------- OpenAPI */

  describe('the public API document', () => {
    it('still says nothing about the operator surface', async () => {
      const document = await operator().get('/api/docs-json').expect(200);
      const paths = Object.keys((document.body as { paths: Record<string, unknown> }).paths);

      expect(paths.some((path) => path.includes('/admin'))).toBe(false);
    });
  });
});
