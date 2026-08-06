import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  PROJECT_ROUTES,
  parseRecoveryFragment,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { configureSecurity } from '../src/security';

/**
 * The complete Phase 2 user journey, in order, as one continuous scenario.
 *
 * The per-endpoint suite in `projects.e2e-spec.ts` proves each operation in
 * isolation; this proves they compose — that state carried between steps
 * (version, session, recovery secret) survives a full session end and recovery.
 *
 * This exercises the workflow at the HTTP layer. Browser-level coverage of the
 * same journey (real cookie jar, fragment handling, `history.replaceState`) is
 * Playwright work and is **not** included — see the Phase 2 report.
 */
describe('Phase 2 project journey (e2e)', () => {
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

  it('walks create -> configure -> leave -> recover -> delete', async () => {
    const browser = request.agent(app.getHttpServer());

    /* 1. Create the project. */
    const created = await browser
      .post(PROJECT_ROUTES.create)
      .send({ name: 'Journey project', clientName: 'Acme Ltd' })
      .expect(201);

    const projectId: string = created.body.project.projectId;
    const recoverySecret: string = created.body.recoverySecret;
    let csrf = csrfFrom(created);

    /* 2. Receive recovery access, in the link fragment. */
    const fragment = created.body.recoveryLink.split('#')[1];
    expect(parseRecoveryFragment(fragment)).toEqual({ projectId, recoverySecret });

    /* 3. Enter the workspace. */
    const entered = await browser.get(PROJECT_ROUTES.current).expect(200);
    expect(entered.body.name).toBe('Journey project');
    let version: number = entered.body.version;

    /* 4. Update project details, including the project type. */
    const details = await browser
      .put(PROJECT_ROUTES.details)
      .set('x-csrf-token', csrf)
      .send({
        version,
        details: {
          name: 'Journey project',
          clientName: 'Acme Ltd',
          projectTypes: ['SAAS_PLATFORM', 'MOBILE_APPLICATION'],
        },
      })
      .expect(200);

    expect(details.body.projectTypes).toEqual(['SAAS_PLATFORM', 'MOBILE_APPLICATION']);
    version = details.body.version;

    /* 5. Configure the mandatory timeline. */
    const timeline = await browser
      .put(PROJECT_ROUTES.timeline)
      .set('x-csrf-token', csrf)
      .send({ version, timeline: { mode: 'WEEKS', weeks: 16 } })
      .expect(200);

    expect(timeline.body.timeline).toEqual({ mode: 'WEEKS', weeks: 16 });
    version = timeline.body.version;

    /* 6. Leave the start date unconfirmed. */
    const startDate = await browser
      .put(PROJECT_ROUTES.startDate)
      .set('x-csrf-token', csrf)
      .send({ version, startDate: { mode: 'NOT_CONFIRMED' } })
      .expect(200);

    expect(startDate.body.startDate).toEqual({ mode: 'NOT_CONFIRMED' });
    version = startDate.body.version;

    /* 7. Configure capacity. */
    const capacity = await browser
      .put(PROJECT_ROUTES.teamCapacity)
      .set('x-csrf-token', csrf)
      .send({
        version,
        teamCapacity: {
          roles: { frontendDeveloper: 2, backendDeveloper: 2, qaEngineer: 1 },
          workingHoursPerDay: 8,
          workingDaysPerWeek: 5,
        },
      })
      .expect(200);

    expect(capacity.body.teamCapacity.roles.frontendDeveloper).toBe(2);
    version = capacity.body.version;

    /* 8. Select output formats. */
    const formats = await browser
      .put(PROJECT_ROUTES.outputPreferences)
      .set('x-csrf-token', csrf)
      .send({
        version,
        outputPreferences: {
          OUR_UNDERSTANDING: ['DOCX', 'PDF'],
          WORK_BREAKDOWN_STRUCTURE: ['XLSX', 'CSV'],
        },
      })
      .expect(200);

    expect(formats.body.outputPreferences.WORK_BREAKDOWN_STRUCTURE).toEqual(['XLSX', 'CSV']);
    version = formats.body.version;

    /* 9. Refresh: the same session restores the same state. */
    const refreshed = await browser.get(PROJECT_ROUTES.current).expect(200);
    expect(refreshed.body.version).toBe(version);
    expect(refreshed.body.timeline).toEqual({ mode: 'WEEKS', weeks: 16 });
    expect(refreshed.body.status).toBe('ACTIVE');

    /* 10. End the project session. */
    await browser.delete(PROJECT_ROUTES.endSession).expect(200);
    await browser.get(PROJECT_ROUTES.current).expect(401);

    /* 11. Recover with the private link, in a clean browser. */
    const returning = request.agent(app.getHttpServer());
    const recovered = await returning
      .post(PROJECT_ROUTES.exchange)
      .send({ projectId, recoverySecret })
      .expect(200);

    expect(recovered.body.project.version).toBe(version);
    expect(recovered.body.project.teamCapacity.roles.qaEngineer).toBe(1);
    csrf = csrfFrom(recovered);

    /* 12. Delete the project. */
    const deleted = await returning
      .delete(PROJECT_ROUTES.delete)
      .set('x-csrf-token', csrf)
      .send({ version, confirmationName: 'Journey project' })
      .expect(200);

    expect(deleted.body.status).toBe('DELETION_PENDING');

    /* 13. Confirm it can no longer be reached, by session or by recovery link. */
    await returning.get(PROJECT_ROUTES.current).expect(401);

    await request
      .agent(app.getHttpServer())
      .post(PROJECT_ROUTES.exchange)
      .send({ projectId, recoverySecret })
      .expect(401);
  }, 60_000);
});

function csrfFrom(response: request.Response): string {
  // supertest types set-cookie loosely; narrow before use.
  const raw: unknown = response.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];

  const cookie = cookies.find((value) => value.startsWith(CSRF_COOKIE));

  return cookie?.split(';')[0]?.split('=')[1] ?? '';
}
