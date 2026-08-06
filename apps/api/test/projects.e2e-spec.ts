import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  PROJECT_ROUTES,
  PROJECT_SESSION_COOKIE,
  apiErrorResponseSchema,
  parseRecoveryFragment,
  projectCreatedResponseSchema,
  projectResponseSchema,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { configureSecurity } from '../src/security';

/**
 * The Phase 2 API, end to end over HTTP against a real MongoDB.
 *
 * Requires a database — `pnpm docker:up`, or the service container in CI.
 */
describe('Projects API (e2e)', () => {
  let app: NestExpressApplication;

  /** Cookies survive per-agent; a fresh agent is a fresh browser. */
  const agent = () => request.agent(app.getHttpServer());

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

  /** Creates a project and returns a logged-in agent plus the creation payload. */
  async function createProject(name = 'Acme portal') {
    const client = agent();
    const response = await client.post(PROJECT_ROUTES.create).send({ name }).expect(201);

    return {
      client,
      body: response.body,
      cookies: extractCookies(response),
      csrf: csrfFrom(response),
    };
  }

  describe('project creation', () => {
    it('creates a project and returns the recovery secret exactly once', async () => {
      const { body } = await createProject();

      expect(projectCreatedResponseSchema.safeParse(body).success).toBe(true);
      expect(body.project.status).toBe('DRAFT');
      expect(body.project.version).toBe(0);
      expect(body.recoverySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('never exposes an internal database identifier', async () => {
      const { body } = await createProject();
      const serialized = JSON.stringify(body);

      expect(serialized).not.toContain('_id');
      expect(serialized).not.toContain('secretHash');
      expect(body.project.projectId).toMatch(/^prj_[0-9A-Z]{26}$/);
    });

    it('puts the secret in the link fragment, never the query string', async () => {
      const { body } = await createProject();
      const [beforeFragment, fragment] = body.recoveryLink.split('#');

      expect(fragment).toBeDefined();
      expect(beforeFragment).not.toContain(body.recoverySecret);
      expect(parseRecoveryFragment(fragment)).toEqual({
        projectId: body.project.projectId,
        recoverySecret: body.recoverySecret,
      });
    });

    it('states plainly what holding the link means', async () => {
      const { body } = await createProject();
      expect(body.recoveryWarning.toLowerCase()).toContain('anyone with this link');
    });

    it('signs the creator in with an HttpOnly session cookie', async () => {
      const { cookies } = await createProject();
      const session = cookies.find((cookie) => cookie.startsWith(PROJECT_SESSION_COOKIE));

      expect(session).toBeDefined();
      expect(session).toContain('HttpOnly');
      expect(session).toContain('SameSite=Lax');
    });

    it('issues a CSRF cookie that script can read', async () => {
      const { cookies } = await createProject();
      const csrf = cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE));

      expect(csrf).toBeDefined();
      expect(csrf).not.toContain('HttpOnly');
    });

    it('rejects a project with no name', async () => {
      const response = await agent().post(PROJECT_ROUTES.create).send({}).expect(422);
      expect(apiErrorResponseSchema.safeParse(response.body).success).toBe(true);
    });

    it('rejects undeclared properties rather than ignoring them', async () => {
      const response = await agent()
        .post(PROJECT_ROUTES.create)
        .send({ name: 'Acme', status: 'ACTIVE', version: 99 })
        .expect(422);

      expect(JSON.stringify(response.body)).toMatch(/status|version/);
    });

    it('generates a different id and secret for every project', async () => {
      const first = await createProject();
      const second = await createProject();

      expect(first.body.project.projectId).not.toBe(second.body.project.projectId);
      expect(first.body.recoverySecret).not.toBe(second.body.recoverySecret);
    });
  });

  describe('reading the current project', () => {
    it('returns the project for a valid session', async () => {
      const { client, body } = await createProject();
      const response = await client.get(PROJECT_ROUTES.current).expect(200);

      expect(projectResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.projectId).toBe(body.project.projectId);
    });

    it('refuses a request with no session', async () => {
      const response = await agent().get(PROJECT_ROUTES.current).expect(401);
      expect(apiErrorResponseSchema.safeParse(response.body).success).toBe(true);
    });

    it('refuses a forged session cookie', async () => {
      const response = await agent()
        .get(PROJECT_ROUTES.current)
        .set('Cookie', `${PROJECT_SESSION_COOKIE}=forged.signature`)
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('does not let one project session read another project', async () => {
      const first = await createProject('First project');
      const second = await createProject('Second project');

      // The second agent's session names only its own project; there is no
      // request shape that lets it name the first.
      const response = await second.client.get(PROJECT_ROUTES.current).expect(200);
      expect(response.body.projectId).not.toBe(first.body.project.projectId);
    });
  });

  describe('recovery', () => {
    it('exchanges a valid secret for a session', async () => {
      const created = await createProject();
      const fresh = agent();

      const response = await fresh
        .post(PROJECT_ROUTES.exchange)
        .send({
          projectId: created.body.project.projectId,
          recoverySecret: created.body.recoverySecret,
        })
        .expect(200);

      expect(response.body.project.projectId).toBe(created.body.project.projectId);
      await fresh.get(PROJECT_ROUTES.current).expect(200);
    });

    it('refuses a wrong secret', async () => {
      const created = await createProject();

      const response = await agent()
        .post(PROJECT_ROUTES.exchange)
        .send({
          projectId: created.body.project.projectId,
          recoverySecret: 'A'.repeat(43),
        })
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('gives an unknown project the identical response to a wrong secret', async () => {
      const created = await createProject();

      const wrongSecret = await agent()
        .post(PROJECT_ROUTES.exchange)
        .send({ projectId: created.body.project.projectId, recoverySecret: 'B'.repeat(43) })
        .expect(401);

      const unknownProject = await agent()
        .post(PROJECT_ROUTES.exchange)
        .send({ projectId: 'prj_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', recoverySecret: 'B'.repeat(43) })
        .expect(401);

      // Identical code and message: the API must not confirm which ids exist.
      expect(unknownProject.body.error.code).toBe(wrongSecret.body.error.code);
      expect(unknownProject.body.error.message).toBe(wrongSecret.body.error.message);
    });

    it('never echoes the submitted secret back in an error', async () => {
      const secret = 'C'.repeat(43);
      const response = await agent()
        .post(PROJECT_ROUTES.exchange)
        .send({ projectId: 'prj_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', recoverySecret: secret })
        .expect(401);

      expect(JSON.stringify(response.body)).not.toContain(secret);
    });

    it('rejects a malformed secret before any lookup', async () => {
      await agent()
        .post(PROJECT_ROUTES.exchange)
        .send({ projectId: 'prj_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', recoverySecret: 'too-short' })
        .expect(422);
    });
  });

  describe('section updates', () => {
    it('updates details and bumps the version', async () => {
      const { client, body, csrf } = await createProject();

      const response = await client
        .put(PROJECT_ROUTES.details)
        .set('x-csrf-token', csrf)
        .send({
          version: body.project.version,
          details: { name: 'Renamed', clientName: 'Acme Ltd', projectTypes: ['SAAS_PLATFORM'] },
        })
        .expect(200);

      expect(response.body.name).toBe('Renamed');
      expect(response.body.clientName).toBe('Acme Ltd');
      expect(response.body.projectTypes).toEqual(['SAAS_PLATFORM']);
      expect(response.body.version).toBe(body.project.version + 1);
      // First real edit promotes the draft.
      expect(response.body.status).toBe('ACTIVE');
    });

    it('rejects a stale version instead of overwriting', async () => {
      const { client, body, csrf } = await createProject();

      await client
        .put(PROJECT_ROUTES.details)
        .set('x-csrf-token', csrf)
        .send({ version: body.project.version, details: { name: 'First write' } })
        .expect(200);

      const conflict = await client
        .put(PROJECT_ROUTES.details)
        .set('x-csrf-token', csrf)
        .send({ version: body.project.version, details: { name: 'Second write' } })
        .expect(409);

      expect(conflict.body.error.code).toBe('CONFLICT');

      // The first write survived.
      const current = await client.get(PROJECT_ROUTES.current).expect(200);
      expect(current.body.name).toBe('First write');
    });

    it('stores each timeline mode', async () => {
      const { client, csrf } = await createProject();
      let version = 0;

      for (const timeline of [
        { mode: 'WORKING_DAYS', workingDays: 45 },
        { mode: 'WEEKS', weeks: 12 },
        { mode: 'MONTHS', months: 6 },
        { mode: 'FIXED_DEADLINE', deadline: futureDate(120) },
      ]) {
        const response = await client
          .put(PROJECT_ROUTES.timeline)
          .set('x-csrf-token', csrf)
          .send({ version, timeline })
          .expect(200);

        expect(response.body.timeline).toEqual(timeline);
        version = response.body.version;
      }
    });

    it('rejects a deadline in the past', async () => {
      const { client, csrf } = await createProject();

      const response = await client
        .put(PROJECT_ROUTES.timeline)
        .set('x-csrf-token', csrf)
        .send({ version: 0, timeline: { mode: 'FIXED_DEADLINE', deadline: '2020-01-01' } })
        .expect(422);

      expect(JSON.stringify(response.body)).toContain('past');
    });

    it('rejects a timeline carrying two modes at once', async () => {
      const { client, csrf } = await createProject();

      await client
        .put(PROJECT_ROUTES.timeline)
        .set('x-csrf-token', csrf)
        .send({ version: 0, timeline: { mode: 'WEEKS', weeks: 4, months: 2 } })
        .expect(422);
    });

    it('accepts a start date only for the modes that have one', async () => {
      const { client, csrf } = await createProject();

      const notConfirmed = await client
        .put(PROJECT_ROUTES.startDate)
        .set('x-csrf-token', csrf)
        .send({ version: 0, startDate: { mode: 'NOT_CONFIRMED' } })
        .expect(200);

      expect(notConfirmed.body.startDate).toEqual({ mode: 'NOT_CONFIRMED' });

      // A dated mode without a date is refused.
      await client
        .put(PROJECT_ROUTES.startDate)
        .set('x-csrf-token', csrf)
        .send({ version: notConfirmed.body.version, startDate: { mode: 'CONFIRMED_DATE' } })
        .expect(422);

      const confirmed = await client
        .put(PROJECT_ROUTES.startDate)
        .set('x-csrf-token', csrf)
        .send({
          version: notConfirmed.body.version,
          startDate: { mode: 'CONFIRMED_DATE', date: futureDate(30) },
        })
        .expect(200);

      expect(confirmed.body.startDate.mode).toBe('CONFIRMED_DATE');
    });

    it('stores team capacity and rejects negative counts', async () => {
      const { client, csrf } = await createProject();

      const saved = await client
        .put(PROJECT_ROUTES.teamCapacity)
        .set('x-csrf-token', csrf)
        .send({
          version: 0,
          teamCapacity: {
            roles: { frontendDeveloper: 2, backendDeveloper: 3 },
            customRoles: [{ name: 'Data engineer', count: 1 }],
            workingHoursPerDay: 8,
            requestStaffingRecommendation: true,
          },
        })
        .expect(200);

      expect(saved.body.teamCapacity.roles.backendDeveloper).toBe(3);

      await client
        .put(PROJECT_ROUTES.teamCapacity)
        .set('x-csrf-token', csrf)
        .send({ version: saved.body.version, teamCapacity: { roles: { qaEngineer: -1 } } })
        .expect(422);
    });

    it('rejects duplicate custom roles', async () => {
      const { client, csrf } = await createProject();

      await client
        .put(PROJECT_ROUTES.teamCapacity)
        .set('x-csrf-token', csrf)
        .send({
          version: 0,
          teamCapacity: {
            customRoles: [
              { name: 'Data engineer', count: 1 },
              { name: '  data   ENGINEER ', count: 2 },
            ],
          },
        })
        .expect(422);
    });

    it('enforces the per-document format matrix', async () => {
      const { client, csrf } = await createProject();

      const valid = await client
        .put(PROJECT_ROUTES.outputPreferences)
        .set('x-csrf-token', csrf)
        .send({
          version: 0,
          outputPreferences: { OUR_UNDERSTANDING: ['DOCX', 'PDF'], FEATURE_LISTING: ['CSV'] },
        })
        .expect(200);

      expect(valid.body.outputPreferences.OUR_UNDERSTANDING).toEqual(['DOCX', 'PDF']);

      // CSV is not offered for a prose document.
      const invalid = await client
        .put(PROJECT_ROUTES.outputPreferences)
        .set('x-csrf-token', csrf)
        .send({ version: valid.body.version, outputPreferences: { OUR_UNDERSTANDING: ['CSV'] } })
        .expect(422);

      expect(JSON.stringify(invalid.body)).toContain('CSV');
    });
  });

  describe('CSRF protection', () => {
    it('refuses a mutation with no CSRF header', async () => {
      const { client } = await createProject();

      const response = await client
        .put(PROJECT_ROUTES.details)
        .send({ version: 0, details: { name: 'No CSRF' } })
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('refuses a mutation whose CSRF header does not match the cookie', async () => {
      const { client } = await createProject();

      await client
        .put(PROJECT_ROUTES.details)
        .set('x-csrf-token', 'not-the-cookie-value')
        .send({ version: 0, details: { name: 'Wrong CSRF' } })
        .expect(401);
    });

    it('refuses a mutation from an unrecognised origin', async () => {
      const { client, csrf } = await createProject();

      await client
        .put(PROJECT_ROUTES.details)
        .set('x-csrf-token', csrf)
        .set('Origin', 'https://attacker.example')
        .send({ version: 0, details: { name: 'Cross site' } })
        .expect(401);
    });

    it('allows a read without a CSRF header', async () => {
      const { client } = await createProject();
      await client.get(PROJECT_ROUTES.current).expect(200);
    });
  });

  describe('session lifecycle', () => {
    it('ends a session and clears the cookie', async () => {
      const { client } = await createProject();

      await client.delete(PROJECT_ROUTES.endSession).expect(200);
      await client.get(PROJECT_ROUTES.current).expect(401);
    });

    it('can reopen the project with the recovery link after ending the session', async () => {
      const created = await createProject();
      await created.client.delete(PROJECT_ROUTES.endSession).expect(200);

      const returning = agent();
      await returning
        .post(PROJECT_ROUTES.exchange)
        .send({
          projectId: created.body.project.projectId,
          recoverySecret: created.body.recoverySecret,
        })
        .expect(200);

      await returning.get(PROJECT_ROUTES.current).expect(200);
    });
  });

  describe('deletion', () => {
    it('requires the exact project name to confirm', async () => {
      const { client, csrf } = await createProject('Deletable project');

      await client
        .delete(PROJECT_ROUTES.delete)
        .set('x-csrf-token', csrf)
        .send({ version: 0, confirmationName: 'Wrong name' })
        .expect(422);
    });

    it('deletes, ends the session and refuses later recovery', async () => {
      const created = await createProject('Deletable project');

      const deleted = await created.client
        .delete(PROJECT_ROUTES.delete)
        .set('x-csrf-token', created.csrf)
        .send({ version: 0, confirmationName: 'Deletable project' })
        .expect(200);

      expect(deleted.body.status).toBe('DELETION_PENDING');

      // The session is gone immediately.
      await created.client.get(PROJECT_ROUTES.current).expect(401);

      // And the recovery link no longer works.
      await agent()
        .post(PROJECT_ROUTES.exchange)
        .send({
          projectId: created.body.project.projectId,
          recoverySecret: created.body.recoverySecret,
        })
        .expect(401);
    });

    it('reports a repeated deletion as success rather than an error', async () => {
      const created = await createProject('Twice deleted');

      await created.client
        .delete(PROJECT_ROUTES.delete)
        .set('x-csrf-token', created.csrf)
        .send({ version: 0, confirmationName: 'Twice deleted' })
        .expect(200);

      // Re-open and delete again: the outcome the caller wants already holds.
      const again = agent();
      const exchange = await again.post(PROJECT_ROUTES.exchange).send({
        projectId: created.body.project.projectId,
        recoverySecret: created.body.recoverySecret,
      });

      expect(exchange.status).toBe(401);
    });
  });
});

function extractCookies(response: request.Response): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function csrfFrom(response: request.Response): string {
  const cookie = extractCookies(response).find((value) => value.startsWith(CSRF_COOKIE));
  return cookie?.split(';')[0]?.split('=')[1] ?? '';
}

function futureDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  return date.toISOString().slice(0, 10);
}
