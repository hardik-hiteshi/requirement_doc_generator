import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ADMIN_TOKEN_HEADER,
  API_PREFIX,
  API_VERSION,
  METRIC_NAMES,
  PROJECT_ROUTES,
  PURGEABLE_COLLECTIONS,
  REQUIREMENT_ROUTES,
} from '@wdrg/contracts';
import type { Connection } from 'mongoose';
import request from 'supertest';

import { RateLimitStore } from '../src/abuse/rate-limit.store';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { MetricsService } from '../src/observability/metrics.service';
import { RetentionService } from '../src/retention/retention.service';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';

/**
 * Operational hardening, against a running application.
 *
 * Three things are being proved, and none of them can be proved by a unit test:
 * that a ceiling actually refuses a real request with the right status and header,
 * that a purge removes what it claims from every collection and leaves what it must,
 * and that the operator surface is genuinely shut when no token is configured.
 *
 * The limits here are the configured ones, so the tests set the environment they
 * need rather than sending six hundred requests to observe a refusal.
 */
describe('Operational hardening (e2e)', () => {
  let app: NestExpressApplication;
  let connection: Connection;
  let store: RateLimitStore;
  let metrics: MetricsService;
  let retention: RetentionService;

  /** A token long enough for production to accept, so one app serves every test. */
  const ADMIN_TOKEN = 'operator-token-of-sufficient-length-000000';

  /**
   * Configuration for this suite alone.
   *
   * The environment cannot be used. `ConfigModule` reads it when `app.module.ts` is
   * imported and caches the validated result, which is why `test/e2e-env.ts` exists
   * and says so — a `beforeAll` assignment is too late. Setting tight ceilings there
   * instead would apply them to every integration suite, and the other five hundred
   * tests would start meeting 429s.
   *
   * So the config provider is replaced with the real class, overriding only the three
   * sections this phase added. Everything else — database, storage, AI, sessions —
   * still comes from the validated environment, so the application under test is the
   * real one.
   */
  class OperationsConfig extends AppConfigService {
    override get rateLimit() {
      return {
        enabled: true,
        maxKeys: 10_000,
        policies: {
          default: { limit: 8, windowSeconds: 60 },
          mutation: { limit: 5, windowSeconds: 60 },
          expensive: { limit: 3, windowSeconds: 60 },
          export: { limit: 2, windowSeconds: 60 },
          upload: { limit: 2, windowSeconds: 60 },
          access: { limit: 3, windowSeconds: 60 },
          /*
           * Generous: this suite creates a project per test, and the class under test
           * for credential guessing is `access`, not this one.
           */
          create: { limit: 200, windowSeconds: 60 },
        },
      };
    }

    override get admin() {
      return { token: ADMIN_TOKEN, enabled: true };
    }

    override get retention() {
      /*
       * Disabled, so the worker's timer never fires. The sweep is driven directly,
       * which is what makes a test about deletion deterministic.
       */
      return {
        enabled: false,
        sweepIntervalMs: 3_600_000,
        policy: { deletionGraceDays: 7, expiredGraceDays: 90, batchSize: 25 },
      };
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useFactory({
        factory: (config: ConfigService) => new OperationsConfig(config as never),
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
    store = app.get(RateLimitStore);
    metrics = app.get(MetricsService);
    retention = app.get(RetentionService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    /* Budgets are per test: one test exhausting a class must not fail the next. */
    store.clear();
    metrics.reset();
  });

  /* ------------------------------------------------------------- helpers */

  async function newProject(name = 'Operations') {
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

  const admin = () => request(app.getHttpServer());

  /* --------------------------------------------------- rate limiting */

  describe('request ceilings', () => {
    it('refuses once the budget is spent, and says how long to wait', async () => {
      const { agent } = await newProject();

      const statuses: number[] = [];

      for (let attempt = 0; attempt < 10; attempt += 1) {
        statuses.push((await agent.get(PROJECT_ROUTES.current)).status);
      }

      /* Eight allowed, then refused — the configured ceiling, exactly. */
      expect(statuses.filter((status) => status === 200)).toHaveLength(8);
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);

      const refused = await agent.get(PROJECT_ROUTES.current);

      expect(refused.status).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(refused.body.error.code).toBe('RATE_LIMITED');
    }, 120_000);

    it('tells a caller its budget before it runs out', async () => {
      const { agent } = await newProject();

      const first = await agent.get(PROJECT_ROUTES.current).expect(200);

      expect(Number(first.headers['x-ratelimit-limit'])).toBe(8);
      expect(Number(first.headers['x-ratelimit-remaining'])).toBe(7);
    }, 120_000);

    it('says nothing about which ceiling was hit', async () => {
      const { agent } = await newProject();

      for (let attempt = 0; attempt < 9; attempt += 1) {
        await agent.get(PROJECT_ROUTES.current);
      }

      const refused = await agent.get(PROJECT_ROUTES.current);
      const error = refused.body.error as Record<string, unknown>;

      /*
       * The body carries the envelope and nothing else — no class name, no ceiling,
       * no count. That combination is a map of the limits, and the person who wants
       * the map is the one probing them.
       *
       * The response headers do state this class's own budget, deliberately: a client
       * that can see its remaining requests can slow down before being refused, and
       * one class's ceiling reveals far less than the shape of all six.
       */
      expect(Object.keys(error).sort()).toEqual([
        'code',
        'correlationId',
        'message',
        'path',
        'status',
        'timestamp',
      ]);
      expect(JSON.stringify(error)).not.toContain('default');
      expect(refused.body.error.message).toContain('Nothing has been changed');
    }, 120_000);

    it("keeps one project from spending another project's budget", async () => {
      const first = await newProject('First');
      const second = await newProject('Second');

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await first.agent.get(PROJECT_ROUTES.current);
      }

      expect((await first.agent.get(PROJECT_ROUTES.current)).status).toBe(429);
      /* The second project is untouched by the first one's flood. */
      expect((await second.agent.get(PROJECT_ROUTES.current)).status).toBe(200);
    }, 180_000);

    it('holds a separate, tighter budget for credential guessing', async () => {
      const attempts: number[] = [];

      /*
       * Recovery attempts from one address, with no session. Three are allowed by
       * this suite's configuration; the fourth is refused whatever secret it carries.
       */
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await request(app.getHttpServer())
          .post(PROJECT_ROUTES.exchange)
          .send({ projectId: 'prj_0000000000000000000000000', secret: `guess-${attempt}` });

        attempts.push(response.status);
      }

      expect(attempts.filter((status) => status === 429).length).toBeGreaterThan(0);
      expect(attempts.slice(0, 3).every((status) => status !== 429)).toBe(true);
    }, 120_000);

    it('counts a refusal, and records one audit event for a flood', async () => {
      const { agent } = await newProject();

      const before = await connection
        .collection('audit_events')
        .countDocuments({ type: 'RATE_LIMIT_EXCEEDED' });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await agent.get(PROJECT_ROUTES.current);
      }

      expect(
        metrics.read(METRIC_NAMES.rateLimitRefusalsTotal, { class: 'default' }),
      ).toBeGreaterThan(0);

      const events = await connection
        .collection('audit_events')
        .find({ type: 'RATE_LIMIT_EXCEEDED' })
        .toArray();

      /*
       * Twelve refusals, one new event. Auditing each would turn a flood into a flood
       * of writes to the collection an investigation later has to read. Measured as a
       * delta, because earlier tests in this file have floods of their own.
       */
      expect(events.length - before).toBe(1);

      /*
       * The event names the class and the method, and no path. It cannot name the
       * project: the limiter runs before the session is verified, on purpose, so the
       * only identity available then is one the caller supplied — and an
       * attacker-chosen value does not belong in the audit trail.
       */
      const latest = events.at(-1);

      expect(latest?.metadata).toMatchObject({ rateClass: 'default', method: 'GET' });
      expect(JSON.stringify(latest?.metadata)).not.toContain('/api/');
    }, 180_000);
  });

  /* ---------------------------------------------------- operator surface */

  describe('the operator surface', () => {
    it('refuses a request with no token, and says nothing useful', async () => {
      const response = await admin().get('/api/v1/admin/status');

      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain(ADMIN_TOKEN);
    });

    it('refuses a wrong token', async () => {
      const response = await admin()
        .get('/api/v1/admin/status')
        .set(ADMIN_TOKEN_HEADER, 'operator-token-of-sufficient-length-000001');

      expect(response.status).toBe(401);
    });

    it('refuses a token of the wrong length without comparing content', async () => {
      const response = await admin().get('/api/v1/admin/status').set(ADMIN_TOKEN_HEADER, 'short');

      expect(response.status).toBe(401);
    });

    it('records every refusal, with no trace of what was presented', async () => {
      await admin().get('/api/v1/admin/status').set(ADMIN_TOKEN_HEADER, 'wrong-token-entirely-000');

      const events = await connection
        .collection('audit_events')
        .find({ type: 'ADMIN_ACCESS_DENIED' })
        .toArray();

      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain('wrong-token-entirely');
    });

    it('reports status to an operator who presents the token', async () => {
      const response = await admin()
        .get('/api/v1/admin/status')
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN)
        .expect(200);

      const body = response.body as {
        projects: Record<string, number>;
        retention: { enabled: boolean; pendingDeletion: number };
        rateLimit: { enabled: boolean };
        storage: { adapter: string };
      };

      expect(body.projects.ACTIVE).toBeGreaterThanOrEqual(0);
      expect(body.retention.enabled).toBe(false);
      expect(body.rateLimit.enabled).toBe(true);
      expect(body.storage.adapter).toBeDefined();
    });

    it('serves audit events newest first, and says when it truncated', async () => {
      await newProject('Audited');

      const response = await admin()
        .get('/api/v1/admin/audit')
        .query({ limit: 1 })
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN)
        .expect(200);

      const body = response.body as { events: { type: string }[]; truncated: boolean };

      expect(body.events).toHaveLength(1);
      expect(body.truncated).toBe(true);
    });

    it('refuses a filter it does not recognise rather than ignoring it', async () => {
      const response = await admin()
        .get('/api/v1/admin/audit')
        .query({ contains: 'secret' })
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN);

      expect(response.status).toBe(422);
    });

    it('serves metrics as exposition text a collector can parse', async () => {
      const response = await admin()
        .get('/api/v1/admin/metrics')
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# TYPE wdrg_process_uptime_seconds gauge');
    });

    it('is excluded from the public API document', async () => {
      const document = await admin().get('/api/docs-json').expect(200);
      const paths = Object.keys((document.body as { paths: Record<string, unknown> }).paths);

      /* An operator has the deployment's documentation; a reader of this does not. */
      expect(paths.some((path) => path.includes('/admin'))).toBe(false);
    });
  });

  /* --------------------------------------------------------- retention */

  describe('retention', () => {
    /** Ages a project's timestamps so a sweep sees what it would see months later. */
    async function age(projectId: string, fields: Record<string, Date | string>): Promise<void> {
      await connection.collection('projects').updateOne({ projectId }, { $set: fields });
    }

    it('brings a stored status up to the expiry the application already applies', async () => {
      const { projectId } = await newProject('Expiring');

      await age(projectId, { expiresAt: new Date(Date.now() - 60_000) });

      const result = await retention.sweep();

      expect(result.expired).toBeGreaterThan(0);

      const record = await connection.collection('projects').findOne({ projectId });

      expect(record?.status).toBe('EXPIRED');
    }, 120_000);

    it('queues an abandoned project rather than purging it outright', async () => {
      const { projectId } = await newProject('Abandoned');
      const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

      await age(projectId, { status: 'EXPIRED', expiresAt: longAgo });

      await retention.sweep();

      const record = await connection.collection('projects').findOne({ projectId });

      /* Pending, not deleted: the state that makes a deletion observable first. */
      expect(record?.status).toBe('DELETION_PENDING');
      expect(record?.deletionRequestedAt).toBeInstanceOf(Date);

      const events = await connection
        .collection('audit_events')
        .find({ projectId, type: 'PROJECT_QUEUED_FOR_DELETION' })
        .toArray();

      expect(events).toHaveLength(1);
    }, 120_000);

    it('leaves a pending project alone until its grace window has passed', async () => {
      const { projectId } = await newProject('Recent deletion');

      await age(projectId, {
        status: 'DELETION_PENDING',
        deletionRequestedAt: new Date(Date.now() - 60_000),
      });

      await retention.sweep();

      const record = await connection.collection('projects').findOne({ projectId });

      expect(record?.status).toBe('DELETION_PENDING');
    }, 120_000);

    it('removes content from every collection, and keeps the record and the trail', async () => {
      const { agent, csrf, projectId } = await newProject('To be purged');

      /* Something in more than one collection, so the purge has real work to do. */
      await agent
        .post(REQUIREMENT_ROUTES.textSources)
        .set('x-csrf-token', csrf)
        .send({ title: 'Brief', text: 'Staff must record their weekly timesheets.' })
        .expect(201);

      const before = await connection
        .collection('requirement_sources')
        .countDocuments({ projectId });

      expect(before).toBeGreaterThan(0);

      await age(projectId, {
        status: 'DELETION_PENDING',
        deletionRequestedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      const result = await retention.sweep();

      expect(result.purged).toBeGreaterThan(0);
      expect(result.recordsRemoved).toBeGreaterThan(0);

      /* Nothing of the project's content survives, in any collection. */
      for (const collection of PURGEABLE_COLLECTIONS) {
        expect(await connection.collection(collection).countDocuments({ projectId })).toBe(0);
      }

      /* The record survives, moved on, so its trail still has a subject. */
      const record = await connection.collection('projects').findOne({ projectId });

      expect(record?.status).toBe('DELETED');

      const events = await connection.collection('audit_events').find({ projectId }).toArray();

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.type === 'PROJECT_PURGED')).toBe(true);
    }, 180_000);

    it('purges one project without touching another', async () => {
      const doomed = await newProject('Doomed');
      const bystander = await newProject('Bystander');

      await bystander.agent
        .post(REQUIREMENT_ROUTES.textSources)
        .set('x-csrf-token', bystander.csrf)
        .send({ title: 'Keep me', text: 'The bystander keeps its requirements.' })
        .expect(201);

      await age(doomed.projectId, {
        status: 'DELETION_PENDING',
        deletionRequestedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      await retention.sweep();

      expect(
        await connection
          .collection('requirement_sources')
          .countDocuments({ projectId: bystander.projectId }),
      ).toBeGreaterThan(0);

      const record = await connection
        .collection('projects')
        .findOne({ projectId: bystander.projectId });

      expect(record?.status).not.toBe('DELETED');
    }, 180_000);

    it('reaches a project that is due even when the pending queue is full of ones that are not', async () => {
      /*
       * The defect this covers: candidates were fetched in natural order and filtered
       * afterwards, so a batch could fill with recently-deleted projects and the sweep
       * would report having purged nothing while genuinely due projects waited behind
       * them. It surfaced as a zero purge once other suites had left pending projects
       * in the shared database.
       */
      const batchSize = 25;
      const recent: string[] = [];

      for (let index = 0; index < batchSize; index += 1) {
        const { projectId } = await newProject(`Recently deleted ${index}`);

        await age(projectId, {
          status: 'DELETION_PENDING',
          deletionRequestedAt: new Date(Date.now() - 60_000),
        });

        recent.push(projectId);
      }

      const due = await newProject('Long overdue');

      await age(due.projectId, {
        status: 'DELETION_PENDING',
        deletionRequestedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      });

      const result = await retention.sweep();

      expect(result.purged).toBeGreaterThan(0);

      const purged = await connection.collection('projects').findOne({ projectId: due.projectId });

      expect(purged?.status).toBe('DELETED');

      /* And the ones inside their grace window were left exactly where they were. */
      for (const projectId of recent.slice(0, 3)) {
        const untouched = await connection.collection('projects').findOne({ projectId });

        expect(untouched?.status).toBe('DELETION_PENDING');
      }
    }, 300_000);

    it('is safe to run twice', async () => {
      const { projectId } = await newProject('Twice');

      await age(projectId, {
        status: 'DELETION_PENDING',
        deletionRequestedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      const first = await retention.sweep();
      const second = await retention.sweep();

      expect(first.purged).toBeGreaterThan(0);
      /* The conditional update matched nothing the second time. */
      expect(second.purged).toBe(0);
      expect(second.failed).toBe(0);
    }, 180_000);

    it('records a sweep that did something, and stays quiet about one that did not', async () => {
      const before = await connection
        .collection('audit_events')
        .countDocuments({ type: 'RETENTION_SWEEP_COMPLETED' });

      await retention.sweep();

      const after = await connection
        .collection('audit_events')
        .countDocuments({ type: 'RETENTION_SWEEP_COMPLETED' });

      /* Nothing was eligible, so nothing was written. */
      expect(after).toBe(before);
    }, 120_000);

    it('lets an operator run a sweep, and reports what it did', async () => {
      const { projectId } = await newProject('Operator triggered');

      await age(projectId, { expiresAt: new Date(Date.now() - 60_000) });

      const response = await admin()
        .post('/api/v1/admin/retention/run')
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN)
        .expect(201);

      const body = response.body as { sweep?: { expired: number } };

      expect(body.sweep?.expired).toBeGreaterThan(0);
    }, 120_000);
  });
});
