import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ANALYSIS_ROUTES,
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  ESTIMATION_ROUTES,
  PROJECT_ROUTES,
  REQUIREMENT_ROUTES,
  STACK_ROUTES,
  type Baseline,
  type EstimateSnapshot,
  type EstimateUnit,
  type StackSnapshot,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';
import {
  ESTIMATION_FIXTURES,
  registerEstimationAssessment,
  type EstimationFixture,
} from './estimation-fixtures';
import { registerStackAnalysis } from './stack-fixtures';

/**
 * The estimation workflow, end to end, against a real database.
 *
 * Organised around the three things the phase promises and could plausibly
 * break: that effort, capacity and duration stay distinct; that the user's
 * timeline is never quietly changed; and that a figure a person set survives
 * everything the application does afterwards.
 *
 * The AI is off in most of these. The deterministic engine is not a fallback —
 * it is the path that always runs, and a test suite that only exercised the AI
 * path would not be testing the arithmetic at all.
 */
describe('Estimation and timeline (e2e)', () => {
  let app: NestExpressApplication;
  let provider: DeterministicProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: process.env.DEBUG_E2E ? ['error'] : false,
    });
    configureSecurity(app, app.get(AppConfigService));
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    setupOpenApi(app, app.get(AppConfigService));
    await app.init();

    provider = app.get(DeterministicProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  /* -------------------------------------------------------------- setup */

  async function newProject(fixture: EstimationFixture) {
    const agent = request.agent(app.getHttpServer());
    const created = await agent
      .post(PROJECT_ROUTES.create)
      .send({ name: fixture.name, projectTypes: [...fixture.projectTypes] })
      .expect(201);

    const raw: unknown = created.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
    const csrf =
      cookies
        .find((value) => value.startsWith(CSRF_COOKIE))
        ?.split(';')[0]
        ?.split('=')[1] ?? '';

    const session = { agent, csrf };

    // The create response carries no version; the first write uses zero, as
    // every other suite in the repository does.
    await setTimeline(session, fixture.timeline, 0);

    if (fixture.startDate) {
      const project = await agent.get(PROJECT_ROUTES.current).expect(200);

      await agent
        .put(PROJECT_ROUTES.startDate)
        .set('x-csrf-token', csrf)
        .send({ startDate: fixture.startDate, version: project.body.version })
        .expect(200);
    }

    return session;
  }

  type Session = Awaited<ReturnType<typeof newProject>>;

  async function setTimeline(
    session: Session,
    timeline: EstimationFixture['timeline'],
    version: number,
  ): Promise<void> {
    await session.agent
      .put(PROJECT_ROUTES.timeline)
      .set('x-csrf-token', session.csrf)
      .send({ timeline, version })
      .expect(200);
  }

  /** A project with an approved baseline and a locked stack. */
  async function readyProject(fixture: EstimationFixture): Promise<Session> {
    const session = await newProject(fixture);

    const created = await session.agent
      .post(REQUIREMENT_ROUTES.textSources)
      .set('x-csrf-token', session.csrf)
      .send(fixture.source)
      .expect(201);

    const blocks = created.body.effectiveContent.blocks as { id: string; text: string }[];

    await session.agent
      .post(REQUIREMENT_ROUTES.review(created.body.sourceId))
      .set('x-csrf-token', session.csrf)
      .send({ version: created.body.version })
      .expect(200);

    registerStackAnalysis(provider, blocks);

    await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true })
      .expect(202);

    await settle(session);

    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline).expect(200)).body
      .baseline as Baseline;

    await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: baseline.recordVersion })
      .expect(201);

    /* And a locked stack, which the estimate is priced against. */
    let stack = (await session.agent.get(STACK_ROUTES.stack).expect(200)).body
      .snapshot as StackSnapshot;

    for (const component of fixture.stack) {
      const response = await session.agent
        .post(STACK_ROUTES.components)
        .set('x-csrf-token', session.csrf)
        .send({
          category: component.category,
          technologyId: component.technologyId,
          selectionSource: 'USER',
          mandatory: false,
          expectedVersion: stack.recordVersion,
        })
        .expect(201);

      stack = response.body.snapshot as StackSnapshot;
    }

    const approved = await session.agent
      .post(STACK_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
      .expect(200);

    await session.agent
      .post(STACK_ROUTES.lock)
      .set('x-csrf-token', session.csrf)
      .send({
        acknowledgedDownstreamAuthority: true,
        expectedVersion: (approved.body.snapshot as StackSnapshot).recordVersion,
      })
      .expect(200);

    return session;
  }

  async function settle(session: Session): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const current = await session.agent.get(ANALYSIS_ROUTES.currentRun).expect(200);
      const status = (current.body as { status?: string } | null)?.status;

      if (!status || ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function readEstimate(session: Session): Promise<EstimateSnapshot> {
    const response = await session.agent.get(ESTIMATION_ROUTES.estimate).expect(200);

    return response.body.snapshot as EstimateSnapshot;
  }

  async function runEstimation(
    session: Session,
    estimate: EstimateSnapshot,
    useAi = false,
  ): Promise<EstimateSnapshot> {
    const response = await session.agent
      .post(ESTIMATION_ROUTES.run)
      .set('x-csrf-token', session.csrf)
      .send({ useAi, expectedVersion: estimate.recordVersion })
      .expect(201);

    return response.body.snapshot as EstimateSnapshot;
  }

  async function estimatedProject(fixture: EstimationFixture): Promise<{
    session: Session;
    estimate: EstimateSnapshot;
  }> {
    const session = await readyProject(fixture);
    const estimate = await runEstimation(session, await readEstimate(session));

    return { session, estimate };
  }

  const fixture = (name: string): EstimationFixture =>
    ESTIMATION_FIXTURES.find((entry) => entry.name === name)!;

  const WEB = fixture('a normal CRUD web application');

  function rolesIn(estimate: EstimateSnapshot): string[] {
    return Object.entries(estimate.effortByRole)
      .filter(([, hours]) => hours > 0)
      .map(([role]) => role);
  }

  function features(estimate: EstimateSnapshot): EstimateUnit[] {
    return estimate.estimates.filter((unit) => !unit.overheadActivity);
  }

  /* ------------------------------------------- 1. the fifteen fixtures */

  describe('the project shapes', () => {
    it.each(ESTIMATION_FIXTURES.map((entry) => [entry.name, entry] as const))(
      'estimates %s',
      async (_name, entry) => {
        const { estimate } = await estimatedProject(entry);

        expect(estimate.estimates.length).toBeGreaterThan(0);
        expect(estimate.totalEffort.expected).toBeGreaterThan(0);

        const roles = rolesIn(estimate);

        for (const role of entry.expectRoles ?? []) {
          expect(roles).toContain(role);
        }

        for (const role of entry.expectNoRoles ?? []) {
          expect(roles).not.toContain(role);
        }
      },
      180_000,
    );
  });

  /* ---------------------------------- 2. effort, capacity and duration */

  it('keeps effort, capacity and duration as three separate answers', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    /* Effort is hours, and it does not depend on the team. */
    const hours = estimate.totalEffort.expected;

    expect(hours).toBeGreaterThan(0);

    /* Capacity is unknown until somebody says who is working. */
    expect(estimate.feasibility.status).toBe('CAPACITY_UNKNOWN');
    expect(estimate.recommendedStaffing.length).toBeGreaterThan(0);

    /* Adding a team changes capacity and feasibility, never the effort. */
    const withTeam = (
      await session.agent
        .put(ESTIMATION_ROUTES.team)
        .set('x-csrf-token', session.csrf)
        .send({
          lines: [
            {
              role: 'BACKEND',
              people: 2,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'FRONTEND',
              people: 2,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'QA',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
          ],
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    expect(withTeam.totalEffort.expected).toBe(hours);
    expect(withTeam.feasibility.status).not.toBe('CAPACITY_UNKNOWN');
    expect(withTeam.utilisation.some((line) => line.availableHours > 0)).toBe(true);

    /* And duration is its own number, from the graph. */
    expect(withTeam.schedule.totalWorkingDays).toBeGreaterThan(0);
    expect(withTeam.schedule.totalWorkingDays).not.toBe(Math.ceil(hours / 6.5));
  }, 180_000);

  it('recommends a team when none was supplied, with fractions kept', async () => {
    const { estimate } = await estimatedProject(fixture('a project with no team supplied'));

    expect(estimate.team.supplied).toBe(false);
    expect(estimate.feasibility.status).toBe('CAPACITY_UNKNOWN');
    expect(estimate.recommendedStaffing.length).toBeGreaterThan(0);
    expect(estimate.recommendedStaffing.some((line) => line.people < 1)).toBe(true);
    expect(estimate.recommendedStaffing.every((line) => line.note.length > 5)).toBe(true);
  }, 180_000);

  /* ------------------------------------------ 3. the timeline is theirs */

  it('reports an aggressive deadline rather than extending it', async () => {
    const { session, estimate } = await estimatedProject(fixture('an aggressive timeline'));

    const withTeam = (
      await session.agent
        .put(ESTIMATION_ROUTES.team)
        .set('x-csrf-token', session.csrf)
        .send({
          lines: [
            {
              role: 'BACKEND',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
          ],
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    expect(withTeam.timelineDescription).toBe('1 week');
    expect(['NOT_FEASIBLE_WITH_CURRENT_CAPACITY', 'HIGH_RISK']).toContain(
      withTeam.feasibility.status,
    );
    /* Five working days, exactly what was asked for. Not adjusted. */
    expect(withTeam.feasibility.availableWorkingDays).toBe(5);
    expect(
      withTeam.feasibility.capacityGapHours > 0 || withTeam.feasibility.scheduleGapDays > 0,
    ).toBe(true);
    expect(withTeam.feasibility.risks.length).toBeGreaterThan(0);
  }, 180_000);

  it('lets a high-risk plan be approved once the risk is acknowledged', async () => {
    const { session, estimate } = await estimatedProject(fixture('an aggressive timeline'));

    /*
     * A team is needed first. With none supplied the status is
     * CAPACITY_UNKNOWN, which is a question rather than a risk — there is
     * nothing to acknowledge until somebody says who is working.
     */
    let current = (
      await session.agent
        .put(ESTIMATION_ROUTES.team)
        .set('x-csrf-token', session.csrf)
        .send({
          lines: [
            {
              role: 'BACKEND',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
          ],
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    /* Blocked, and the blocker says what is missing. */
    const refusal = await session.agent
      .post(ESTIMATION_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: current.recordVersion })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('unacknowledged_risk');

    current = (
      await session.agent
        .post(ESTIMATION_ROUTES.acknowledgeRisk)
        .set('x-csrf-token', session.csrf)
        .send({
          acknowledged: true,
          note: 'The client knows and wants to proceed.',
          expectedVersion: current.recordVersion,
        })
        .expect(201)
    ).body.snapshot as EstimateSnapshot;

    expect(current.riskAcknowledgedStatus).toBe(current.feasibility.status);

    const approved = (
      await session.agent
        .post(ESTIMATION_ROUTES.approve)
        .set('x-csrf-token', session.csrf)
        .send({ acknowledgedAiAssistance: true, expectedVersion: current.recordVersion })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    expect(approved.status).toBe('APPROVED');
    /* Approved with the risk on the record, not with the risk removed. */
    expect(approved.feasibility.status).toBe(current.feasibility.status);
  }, 180_000);

  it('refuses to acknowledge a risk that is not there', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    /* CAPACITY_UNKNOWN is not a risk to accept — it is a question to answer. */
    const refusal = await session.agent
      .post(ESTIMATION_ROUTES.acknowledgeRisk)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledged: true, expectedVersion: estimate.recordVersion })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('NO_RISK_TO_ACKNOWLEDGE');
  }, 180_000);

  /* ------------------------------------------------- 4. the schedule */

  it('produces a relative schedule when there is no start date', async () => {
    const { estimate } = await estimatedProject(fixture('a project with no start date'));

    expect(estimate.schedule.relativeOnly).toBe(true);
    expect(estimate.schedule.startDate).toBeUndefined();
    expect(estimate.schedule.tasks.every((task) => task.startDate === undefined)).toBe(true);
    expect(estimate.schedule.tasks[0]?.startDay).toBe(1);
  }, 180_000);

  it('produces real dates when there is a start date', async () => {
    const { estimate } = await estimatedProject(fixture('a project with a confirmed start date'));

    expect(estimate.schedule.relativeOnly).toBe(false);
    expect(estimate.schedule.startDate).toBe('2026-09-07');
    expect(estimate.schedule.tasks[0]?.startDate).toBe('2026-09-07');
    expect(estimate.milestones.every((milestone) => milestone.date !== undefined)).toBe(true);
  }, 180_000);

  /* The rule the whole working-day-offset design exists for. */
  it('changes only the dates when the start date moves', async () => {
    const { session, estimate } = await estimatedProject(
      fixture('a project with a confirmed start date'),
    );

    const before = {
      hours: estimate.totalEffort.expected,
      byRole: estimate.effortByRole,
      days: estimate.schedule.totalWorkingDays,
      criticalPath: estimate.schedule.criticalPath,
      startDate: estimate.schedule.startDate,
    };

    const project = await session.agent.get(PROJECT_ROUTES.current).expect(200);

    await session.agent
      .put(PROJECT_ROUTES.startDate)
      .set('x-csrf-token', session.csrf)
      .send({
        startDate: { mode: 'CONFIRMED_DATE', date: '2026-11-02' },
        version: project.body.version,
      })
      .expect(200);

    const after = (
      await session.agent
        .post(ESTIMATION_ROUTES.recalculateSchedule)
        .set('x-csrf-token', session.csrf)
        .send({ expectedVersion: estimate.recordVersion })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    expect(after.totalEffort.expected).toBe(before.hours);
    expect(after.effortByRole).toEqual(before.byRole);
    expect(after.schedule.totalWorkingDays).toBe(before.days);
    expect(after.schedule.criticalPath).toEqual(before.criticalPath);
    /* Only this moved. */
    expect(after.schedule.startDate).toBe('2026-11-02');
    expect(after.schedule.startDate).not.toBe(before.startDate);
  }, 180_000);

  it('skips holidays when it lays out dates', async () => {
    const { session, estimate } = await estimatedProject(
      fixture('a project with a confirmed start date'),
    );

    const withHoliday = (
      await session.agent
        .put(ESTIMATION_ROUTES.calendar)
        .set('x-csrf-token', session.csrf)
        .send({
          calendar: {
            ...estimate.calendar,
            holidays: ['2026-09-08', '2026-09-09', '2026-09-10'],
          },
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    const first = withHoliday.schedule.tasks[0]!;

    /* The work is the same length; it just finishes later in the calendar. */
    expect(withHoliday.totalEffort.expected).toBe(estimate.totalEffort.expected);
    expect(first.startDate).toBe('2026-09-07');
    expect(new Date(withHoliday.schedule.finishDate!).getTime()).toBeGreaterThan(
      new Date(estimate.schedule.finishDate!).getTime(),
    );
  }, 180_000);

  it('says it needs a start date for a fixed deadline with none', async () => {
    const session = await readyProject({
      ...fixture('a project with a fixed deadline'),
      startDate: undefined,
    });
    const estimate = await runEstimation(session, await readEstimate(session));

    expect(estimate.feasibility.status).toBe('TIMELINE_UNMEASURABLE');
    expect(estimate.feasibility.availableWorkingDays).toBeNull();
    expect(estimate.feasibility.reason).toContain('start date');
  }, 180_000);

  /* ------------------------- 4b. a fixed deadline, start date unknown */

  /**
   * The combination the whole start-date design exists for: the client has named
   * a delivery date and nobody has agreed when work begins.
   *
   * The deadline is authoritative from the first moment and is never touched.
   * What changes as a start date appears is only what a start date can change —
   * dates, available days, capacity and the verdict. The hours do not move,
   * because hours never depended on which Monday the work begins.
   */
  describe('a fixed delivery deadline', () => {
    const DEADLINE = fixture('a project with a fixed deadline');
    /** The deadline every test below measures against. */
    const DEADLINE_DATE =
      DEADLINE.timeline.mode === 'FIXED_DEADLINE' ? DEADLINE.timeline.deadline : '';

    async function deadlineProject(
      startDate: EstimationFixture['startDate'],
    ): Promise<{ session: Session; estimate: EstimateSnapshot }> {
      const session = await readyProject({ ...DEADLINE, startDate });

      return { session, estimate: await runEstimation(session, await readEstimate(session)) };
    }

    async function setStartDate(
      session: Session,
      startDate: Record<string, unknown>,
      status: number,
    ) {
      const project = await session.agent.get(PROJECT_ROUTES.current).expect(200);

      return session.agent
        .put(PROJECT_ROUTES.startDate)
        .set('x-csrf-token', session.csrf)
        .send({ startDate, version: project.body.version })
        .expect(status);
    }

    async function recalculate(session: Session): Promise<EstimateSnapshot> {
      const current = await readEstimate(session);

      return (
        await session.agent
          .post(ESTIMATION_ROUTES.recalculateSchedule)
          .set('x-csrf-token', session.csrf)
          .send({ expectedVersion: current.recordVersion })
          .expect(200)
      ).body.snapshot as EstimateSnapshot;
    }

    /**
     * One engineer for every role the plan actually uses, so the verdict is a
     * measurement rather than a shrug.
     *
     * Derived from the estimate rather than hard-coded: a role with planned hours
     * and nobody assigned reports its whole effort as a gap whatever the span is,
     * which would make the span the one thing the test could not detect.
     */
    async function setTeam(session: Session): Promise<EstimateSnapshot> {
      const current = await readEstimate(session);

      return (
        await session.agent
          .put(ESTIMATION_ROUTES.team)
          .set('x-csrf-token', session.csrf)
          .send({
            lines: rolesIn(current).map((role) => ({
              role,
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            })),
            expectedVersion: current.recordVersion,
          })
          .expect(200)
      ).body.snapshot as EstimateSnapshot;
    }

    it.each([['NOT_CONFIRMED'], ['IMMEDIATELY_AFTER_APPROVAL']])(
      'keeps the deadline and estimates everything it can with a %s start date',
      async (mode) => {
        const { estimate } = await deadlineProject({ mode });

        /* The deadline, exactly as set. */
        expect(estimate.timelineDescription).toBe(`delivery by ${DEADLINE_DATE}`);
        expect(estimate.startDateMode).toBe(mode);
        expect(estimate.startDate).toBeUndefined();

        /* Effort, roles and duration are all calculable without a start date. */
        expect(estimate.totalEffort.expected).toBeGreaterThan(0);
        expect(rolesIn(estimate).length).toBeGreaterThan(0);
        expect(features(estimate).length).toBeGreaterThan(0);
        expect(estimate.schedule.totalWorkingDays).toBeGreaterThan(0);
        expect(estimate.schedule.criticalPath.length).toBeGreaterThan(0);

        /* Feasibility against the deadline is not one of them. */
        expect(estimate.feasibility.status).toBe('TIMELINE_UNMEASURABLE');
        expect(estimate.feasibility.determinacy).toBe('CONDITIONAL');
        expect(estimate.feasibility.availableWorkingDays).toBeNull();
        expect(estimate.feasibility.missingInformation.map((missing) => missing.kind)).toContain(
          'concrete_start_date',
        );
        expect(estimate.feasibility.reason).toContain('kept exactly as you set it');

        /* And no capacity is invented out of the gap between "unknown" and the date. */
        expect(estimate.feasibility.availableHours).toBe(0);
        expect(estimate.feasibility.capacityGapHours).toBe(0);
        expect(estimate.recommendedStaffing).toEqual([]);
      },
      180_000,
    );

    it.each([['TENTATIVE_DATE'], ['CONFIRMED_DATE']])(
      'measures the deadline against a %s start date',
      async (mode) => {
        const { session, estimate } = await deadlineProject({ mode, date: '2026-09-07' });

        expect(estimate.timelineDescription).toBe(`delivery by ${DEADLINE_DATE}`);
        expect(estimate.startDate).toBe('2026-09-07');
        expect(estimate.schedule.relativeOnly).toBe(false);
        expect(estimate.schedule.startDate).toBe('2026-09-07');
        expect(estimate.schedule.finishDate).toBeDefined();

        /* There is a span now, so the deadline can be measured. */
        expect(estimate.feasibility.status).not.toBe('TIMELINE_UNMEASURABLE');
        expect(estimate.feasibility.availableWorkingDays).toBeGreaterThan(0);
        expect(
          estimate.feasibility.missingInformation.map((missing) => missing.kind),
        ).not.toContain('concrete_start_date');

        /*
         * The team is the only thing still missing — a start date resolves the
         * span, not who is available. With one, the verdict is final.
         */
        const withTeam = await setTeam(session);

        expect(withTeam.feasibility.determinacy).toBe('DETERMINED');
        expect(withTeam.feasibility.missingInformation).toEqual([]);
        expect(withTeam.totalEffort.expected).toBe(estimate.totalEffort.expected);
      },
      180_000,
    );

    it('emits no calendar date at all while the start date is unknown', async () => {
      const { estimate } = await deadlineProject({ mode: 'NOT_CONFIRMED' });

      expect(estimate.schedule.relativeOnly).toBe(true);
      expect(estimate.schedule.startDate).toBeUndefined();
      expect(estimate.schedule.finishDate).toBeUndefined();
      expect(estimate.schedule.tasks.every((task) => task.startDate === undefined)).toBe(true);
      expect(estimate.schedule.tasks.every((task) => task.endDate === undefined)).toBe(true);
      expect(estimate.milestones.every((milestone) => milestone.date === undefined)).toBe(true);

      /*
       * A sweep rather than a field list: a plausible-looking date appearing
       * anywhere in the schedule is the failure, wherever somebody adds it.
       */
      expect(
        JSON.stringify({ schedule: estimate.schedule, milestones: estimate.milestones }),
      ).not.toMatch(/\d{4}-\d{2}-\d{2}/);

      /* The deadline itself is still on the record, ready to be measured. */
      expect(estimate.timelineDescription).toContain(DEADLINE_DATE);
    }, 180_000);

    it('changes only the schedule and the verdict when a start date arrives later', async () => {
      const { session, estimate } = await deadlineProject({ mode: 'NOT_CONFIRMED' });

      const before = {
        hours: estimate.totalEffort.expected,
        range: estimate.totalEffort,
        byRole: estimate.effortByRole,
        days: estimate.schedule.totalWorkingDays,
        criticalPath: estimate.schedule.criticalPath,
        units: estimate.estimates.map((unit) => ({ id: unit.id, hours: unit.totalHours })),
        timeline: estimate.timelineDescription,
      };

      await setStartDate(session, { mode: 'CONFIRMED_DATE', date: '2026-09-07' }, 200);
      const after = await recalculate(session);

      /* Effort: untouched, to the hour. */
      expect(after.totalEffort).toEqual(before.range);
      expect(after.totalEffort.expected).toBe(before.hours);
      expect(after.effortByRole).toEqual(before.byRole);
      expect(after.estimates.map((unit) => ({ id: unit.id, hours: unit.totalHours }))).toEqual(
        before.units,
      );

      /* Duration: the same sequence, now expressed in dates as well. */
      expect(after.schedule.totalWorkingDays).toBe(before.days);
      expect(after.schedule.criticalPath).toEqual(before.criticalPath);
      expect(after.schedule.startDate).toBe('2026-09-07');

      /* The deadline can now be measured, and it never moved. */
      expect(after.feasibility.status).not.toBe('TIMELINE_UNMEASURABLE');
      expect(after.feasibility.availableWorkingDays).toBeGreaterThan(0);
      expect(after.feasibility.missingInformation.map((missing) => missing.kind)).not.toContain(
        'concrete_start_date',
      );
      expect(after.timelineDescription).toBe(before.timeline);
    }, 180_000);

    it('reports a worse fit when the start date moves later, and keeps the deadline', async () => {
      const { session } = await deadlineProject({ mode: 'CONFIRMED_DATE', date: '2026-09-07' });
      await setTeam(session);

      const early = await recalculate(session);

      /* Late enough that the deadline leaves a single working day. */
      await setStartDate(session, { mode: 'CONFIRMED_DATE', date: '2026-12-18' }, 200);
      const late = await recalculate(session);

      /* Less runway to the same date. */
      expect(late.feasibility.availableWorkingDays!).toBeLessThan(
        early.feasibility.availableWorkingDays!,
      );

      /* Measurably worse, in whichever unit it went wrong. */
      const pressure = (snapshot: EstimateSnapshot): number =>
        snapshot.feasibility.scheduleGapDays + snapshot.feasibility.capacityGapHours;
      expect(pressure(late)).toBeGreaterThan(pressure(early));

      /* And the effort and the deadline are exactly what they were. */
      expect(late.totalEffort.expected).toBe(early.totalEffort.expected);
      expect(late.timelineDescription).toBe(`delivery by ${DEADLINE_DATE}`);
    }, 180_000);

    it('reports a better fit when the start date moves earlier, and keeps the deadline', async () => {
      const { session } = await deadlineProject({ mode: 'CONFIRMED_DATE', date: '2026-12-18' });
      await setTeam(session);

      const late = await recalculate(session);

      await setStartDate(session, { mode: 'CONFIRMED_DATE', date: '2026-09-07' }, 200);
      const early = await recalculate(session);

      expect(early.feasibility.availableWorkingDays!).toBeGreaterThan(
        late.feasibility.availableWorkingDays!,
      );

      const pressure = (snapshot: EstimateSnapshot): number =>
        snapshot.feasibility.scheduleGapDays + snapshot.feasibility.capacityGapHours;
      expect(pressure(early)).toBeLessThan(pressure(late));

      expect(early.totalEffort.expected).toBe(late.totalEffort.expected);
      expect(early.timelineDescription).toBe(`delivery by ${DEADLINE_DATE}`);
    }, 180_000);

    it('respects weekends and holidays between the start and the deadline', async () => {
      const { session, estimate } = await deadlineProject({
        mode: 'CONFIRMED_DATE',
        date: '2026-09-07',
      });

      const before = estimate.feasibility.availableWorkingDays!;

      /* Three holidays, all of them Mondays and Tuesdays inside the span. */
      const holidays = ['2026-09-14', '2026-09-15', '2026-10-05'];

      const withHolidays = (
        await session.agent
          .put(ESTIMATION_ROUTES.calendar)
          .set('x-csrf-token', session.csrf)
          .send({
            calendar: { ...estimate.calendar, holidays },
            expectedVersion: estimate.recordVersion,
          })
          .expect(200)
      ).body.snapshot as EstimateSnapshot;

      /* Exactly three fewer days available, and not one of them a weekend. */
      expect(withHolidays.feasibility.availableWorkingDays).toBe(before - holidays.length);

      /*
       * A weekend costs nothing, because it was never counted. Adding one as a
       * holiday would reduce the total if weekends were being counted as
       * available — which is the mistake this asserts against.
       */
      const withWeekend = (
        await session.agent
          .put(ESTIMATION_ROUTES.calendar)
          .set('x-csrf-token', session.csrf)
          .send({
            calendar: { ...estimate.calendar, holidays: [...holidays, '2026-09-12', '2026-09-13'] },
            expectedVersion: withHolidays.recordVersion,
          })
          .expect(200)
      ).body.snapshot as EstimateSnapshot;

      expect(withWeekend.feasibility.availableWorkingDays).toBe(
        withHolidays.feasibility.availableWorkingDays,
      );
      expect(withWeekend.timelineDescription).toBe(`delivery by ${DEADLINE_DATE}`);
    }, 180_000);

    it('refuses a start date after the deadline, from either side', async () => {
      const { session, estimate } = await deadlineProject({ mode: 'NOT_CONFIRMED' });

      /* Setting a start beyond the deadline. */
      const refusedStart = await setStartDate(
        session,
        { mode: 'CONFIRMED_DATE', date: '2027-01-15' },
        422,
      );

      expect(JSON.stringify(refusedStart.body)).toContain('deadline_before_start');

      /* Nothing was stored — the project still has no start date. */
      const untouched = await session.agent.get(PROJECT_ROUTES.current).expect(200);
      expect(untouched.body.startDate?.mode ?? 'NOT_CONFIRMED').toBe('NOT_CONFIRMED');

      /* And the same contradiction from the other direction. */
      await setStartDate(session, { mode: 'CONFIRMED_DATE', date: '2026-09-07' }, 200);

      const project = await session.agent.get(PROJECT_ROUTES.current).expect(200);
      const refusedDeadline = await session.agent
        .put(PROJECT_ROUTES.timeline)
        .set('x-csrf-token', session.csrf)
        .send({
          timeline: { mode: 'FIXED_DEADLINE', deadline: '2026-08-20' },
          version: project.body.version,
        })
        .expect(422);

      expect(JSON.stringify(refusedDeadline.body)).toContain('deadline_before_start');

      /* The estimate is still the one it was, against the deadline it was set. */
      const after = await readEstimate(session);
      expect(after.totalEffort.expected).toBe(estimate.totalEffort.expected);
      expect(after.timelineDescription).toBe(`delivery by ${DEADLINE_DATE}`);
    }, 180_000);
  });

  /* -------------------------------------------- 5. work in parallel */

  it('runs work in parallel and reports role contention', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const solo = (
      await session.agent
        .put(ESTIMATION_ROUTES.team)
        .set('x-csrf-token', session.csrf)
        .send({
          lines: [
            {
              role: 'BACKEND',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
          ],
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    const team = (
      await session.agent
        .put(ESTIMATION_ROUTES.team)
        .set('x-csrf-token', session.csrf)
        .send({
          lines: [
            {
              role: 'BACKEND',
              people: 4,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
          ],
          expectedVersion: solo.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    /* More people, same hours, shorter schedule. That is the whole point. */
    expect(team.totalEffort.expected).toBe(solo.totalEffort.expected);
    expect(team.schedule.totalWorkingDays).toBeLessThan(solo.schedule.totalWorkingDays);
  }, 180_000);

  /* ------------------------------------------------ 6. dependencies */

  it('reschedules when a dependency is added, and refuses a cycle', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const [first, second] = features(estimate);

    expect(first && second).toBeTruthy();

    const withEdge = (
      await session.agent
        .post(ESTIMATION_ROUTES.dependencies)
        .set('x-csrf-token', session.csrf)
        .send({
          predecessorId: first!.id,
          successorId: second!.id,
          type: 'FINISH_TO_START',
          reason: 'user_defined',
          lagDays: 0,
          expectedVersion: estimate.recordVersion,
        })
        .expect(201)
    ).body.snapshot as EstimateSnapshot;

    const scheduledFirst = withEdge.schedule.tasks.find((task) => task.taskId === first!.id)!;
    const scheduledSecond = withEdge.schedule.tasks.find((task) => task.taskId === second!.id)!;

    expect(scheduledSecond.startDay).toBeGreaterThan(scheduledFirst.endDay);

    /* And the reverse edge is refused rather than stored and reported. */
    const refusal = await session.agent
      .post(ESTIMATION_ROUTES.dependencies)
      .set('x-csrf-token', session.csrf)
      .send({
        predecessorId: second!.id,
        successorId: first!.id,
        type: 'FINISH_TO_START',
        reason: 'user_defined',
        lagDays: 0,
        expectedVersion: withEdge.recordVersion,
      })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('DEPENDENCY_CYCLE');
  }, 180_000);

  it('refuses a dependency on a task that is not in the plan', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const refusal = await session.agent
      .post(ESTIMATION_ROUTES.dependencies)
      .set('x-csrf-token', session.csrf)
      .send({
        predecessorId: features(estimate)[0]!.id,
        successorId: 'est_DOES_NOT_EXIST',
        type: 'FINISH_TO_START',
        reason: 'user_defined',
        lagDays: 0,
        expectedVersion: estimate.recordVersion,
      })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('UNKNOWN_TASK');
  }, 180_000);

  it('calculates the critical path and the slack from the graph', async () => {
    const { estimate } = await estimatedProject(WEB);

    expect(estimate.schedule.criticalPath.length).toBeGreaterThan(0);
    expect(
      estimate.schedule.tasks.every((task) => task.onCriticalPath === (task.slackDays === 0)),
    ).toBe(true);
  }, 180_000);

  /* --------------------------------------------- 7. override authority */

  it('keeps a user override through a re-estimation', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const target = features(estimate)[0]!;

    const overridden = (
      await session.agent
        .patch(ESTIMATION_ROUTES.estimateUnit(target.id))
        .set('x-csrf-token', session.csrf)
        .send({
          effort: { BACKEND: 99 },
          note: 'We have built this before.',
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    const mine = overridden.estimates.find((unit) => unit.id === target.id)!;

    expect(mine.source).toBe('USER_OVERRIDE');
    expect(mine.effort.BACKEND).toBe(99);
    expect(mine.originalTotalHours).toBe(target.totalHours);

    /* Re-estimating replaces everything the application authored — and nothing else. */
    const rerun = await runEstimation(session, overridden);
    const survivor = rerun.estimates.find((unit) => unit.id === target.id);

    expect(survivor).toBeDefined();
    expect(survivor!.effort.BACKEND).toBe(99);
    expect(survivor!.source).toBe('USER_OVERRIDE');
    expect(survivor!.overrideNote).toBe('We have built this before.');
  }, 180_000);

  it('puts an override back when asked', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const target = features(estimate)[0]!;

    const overridden = (
      await session.agent
        .patch(ESTIMATION_ROUTES.estimateUnit(target.id))
        .set('x-csrf-token', session.csrf)
        .send({ effort: { BACKEND: 99 }, expectedVersion: estimate.recordVersion })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    const reset = (
      await session.agent
        .post(ESTIMATION_ROUTES.resetEstimate(target.id))
        .set('x-csrf-token', session.csrf)
        .send({ expectedVersion: overridden.recordVersion })
        .expect(201)
    ).body.snapshot as EstimateSnapshot;

    const restored = reset.estimates.find((unit) => unit.id === target.id)!;

    expect(restored.totalHours).toBe(target.totalHours);
    expect(restored.source).toBe('SYSTEM_CALCULATED');
  }, 180_000);

  it('refuses an impossible number of hours, including from a person', async () => {
    const { session, estimate } = await estimatedProject(WEB);
    const unitId = features(estimate)[0]!.id;

    /*
     * Refused at the schema, which is the outer of two guards. The inner one —
     * `isPlausibleHours` in the service — catches anything the schema lets past,
     * and both exist because a negative figure corrupts every total above it.
     */
    const negative = await session.agent
      .patch(ESTIMATION_ROUTES.estimateUnit(unitId))
      .set('x-csrf-token', session.csrf)
      .send({ effort: { BACKEND: -5 }, expectedVersion: estimate.recordVersion })
      .expect(422);

    expect(JSON.stringify(negative.body)).toContain('effort.BACKEND');

    const absurd = await session.agent
      .patch(ESTIMATION_ROUTES.estimateUnit(unitId))
      .set('x-csrf-token', session.csrf)
      .send({ effort: { BACKEND: 99_999_999 }, expectedVersion: estimate.recordVersion })
      .expect(422);

    expect(absurd.status).toBe(422);

    /* And nothing was stored: the figure is exactly as it was. */
    const after = await readEstimate(session);

    expect(after.estimates.find((unit) => unit.id === unitId)!.totalHours).toBe(
      features(estimate)[0]!.totalHours,
    );
  }, 180_000);

  it('lets a line be added by hand and keeps it as the user’s', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const added = (
      await session.agent
        .post(ESTIMATION_ROUTES.estimates)
        .set('x-csrf-token', session.csrf)
        .send({
          feature: 'Data migration from the old spreadsheet',
          taskCategory: 'migration',
          complexity: 'MEDIUM',
          uncertainty: 'HIGH',
          effort: { BACKEND: 24, QA: 8 },
          expectedVersion: estimate.recordVersion,
        })
        .expect(201)
    ).body.snapshot as EstimateSnapshot;

    const mine = added.estimates.find((unit) => unit.feature.startsWith('Data migration'))!;

    expect(mine.source).toBe('USER_OVERRIDE');
    expect(mine.totalHours).toBe(32);

    const rerun = await runEstimation(session, added);

    expect(rerun.estimates.some((unit) => unit.id === mine.id)).toBe(true);
  }, 180_000);

  it('refuses a role the project does not have', async () => {
    const { session, estimate } = await estimatedProject(fixture('an API-only service'));

    const refusal = await session.agent
      .post(ESTIMATION_ROUTES.estimates)
      .set('x-csrf-token', session.csrf)
      .send({
        feature: 'A screen',
        taskCategory: 'ui_implementation',
        complexity: 'LOW',
        uncertainty: 'LOW',
        effort: { FRONTEND: 20 },
        expectedVersion: estimate.recordVersion,
      })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('ROLE_NOT_APPLICABLE');
  }, 180_000);

  /* ------------------------------------------------ 8. manual mode */

  it('estimates with no AI at all, and records that none was used', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    expect(estimate.estimates.length).toBeGreaterThan(0);
    expect(estimate.estimates.every((unit) => unit.source !== 'AI_PROPOSED')).toBe(true);

    const run = await session.agent.get(ESTIMATION_ROUTES.currentRun).expect(200);

    expect(run.body.run.provider).toBe('none');
    expect(run.body.run.status).toBe('completed');
    expect(run.body.run.unitsProduced).toBeGreaterThan(0);
  }, 180_000);

  it('uses the AI when asked, and still does its own arithmetic', async () => {
    const session = await readyProject(WEB);
    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline).expect(200)).body
      .baseline as Baseline;

    registerEstimationAssessment(provider, baseline.itemIds);

    const estimate = await runEstimation(session, await readEstimate(session), true);

    expect(estimate.estimates.some((unit) => unit.source === 'AI_PROPOSED')).toBe(true);
    /* Hours still came from the application, so every line has a real range. */
    expect(
      estimate.estimates.every(
        (unit) => unit.range.optimistic <= unit.range.expected && unit.totalHours > 0,
      ),
    ).toBe(true);

    const run = await session.agent.get(ESTIMATION_ROUTES.currentRun).expect(200);

    expect(run.body.run.provider).toBe('deterministic');
    expect(run.body.run.productivityModelVersion).toBe('v1');
  }, 180_000);

  /* ------------------------------------------ 9. upstream and approval */

  it('refuses to estimate without an approved baseline', async () => {
    const session = await newProject(WEB);
    const estimate = await readEstimate(session);

    expect(estimate.blockers[0]?.kind).toBe('baseline_not_approved');

    await session.agent
      .post(ESTIMATION_ROUTES.run)
      .set('x-csrf-token', session.csrf)
      .send({ useAi: false, expectedVersion: estimate.recordVersion })
      .expect(422);
  }, 180_000);

  it('refuses to estimate without a locked stack', async () => {
    const session = await newProject(WEB);

    const created = await session.agent
      .post(REQUIREMENT_ROUTES.textSources)
      .set('x-csrf-token', session.csrf)
      .send(WEB.source)
      .expect(201);

    const blocks = created.body.effectiveContent.blocks as { id: string; text: string }[];

    await session.agent
      .post(REQUIREMENT_ROUTES.review(created.body.sourceId))
      .set('x-csrf-token', session.csrf)
      .send({ version: created.body.version })
      .expect(200);

    registerStackAnalysis(provider, blocks);

    await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true })
      .expect(202);

    await settle(session);

    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline).expect(200)).body
      .baseline as Baseline;

    await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: baseline.recordVersion })
      .expect(201);

    const estimate = await readEstimate(session);

    expect(estimate.blockers[0]?.kind).toBe('stack_not_locked');
  }, 180_000);

  it('marks the estimate out of date when the requirements change', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const added = await session.agent
      .post(REQUIREMENT_ROUTES.textSources)
      .set('x-csrf-token', session.csrf)
      .send({ title: 'Late addition', text: 'Timesheets must also be exported as PDF.' })
      .expect(201);

    const review = await session.agent
      .post(REQUIREMENT_ROUTES.review(added.body.sourceId))
      .set('x-csrf-token', session.csrf)
      .send({ version: added.body.version })
      .expect(200);

    expect(review.status).toBe(200);

    const after = await readEstimate(session);

    expect(after.blockers.map((blocker) => blocker.kind)).toContain('baseline_not_current');
    /* Nothing was re-estimated. The hours are exactly as they were. */
    expect(after.totalEffort.expected).toBe(estimate.totalEffort.expected);
  }, 180_000);

  it('marks the estimate out of date when the locked stack is reopened', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const stack = (await session.agent.get(STACK_ROUTES.stack).expect(200)).body
      .snapshot as StackSnapshot;

    await session.agent
      .post(STACK_ROUTES.unlock)
      .set('x-csrf-token', session.csrf)
      .send({ reason: 'The client changed the database.', expectedVersion: stack.recordVersion })
      .expect(200);

    const after = await readEstimate(session);

    expect(after.blockers.map((blocker) => blocker.kind)).toContain('stack_not_locked');
    expect(after.totalEffort.expected).toBe(estimate.totalEffort.expected);
  }, 180_000);

  it('marks the estimate out of date when the timeline changes', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const project = await session.agent.get(PROJECT_ROUTES.current).expect(200);

    await setTimeline(session, { mode: 'WEEKS', weeks: 2 }, project.body.version as number);

    const after = await readEstimate(session);

    /* The effort is untouched; only what it is measured against moved. */
    expect(after.totalEffort.expected).toBe(estimate.totalEffort.expected);
    expect(after.timelineDescription).toBe('2 weeks');
    expect(after.feasibility.availableWorkingDays).toBe(10);
  }, 180_000);

  it('approves and reopens, keeping the approved version intact', async () => {
    const { session, estimate } = await estimatedProject(WEB);

    const withTeam = (
      await session.agent
        .put(ESTIMATION_ROUTES.team)
        .set('x-csrf-token', session.csrf)
        .send({
          lines: [
            {
              role: 'BACKEND',
              people: 3,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'FRONTEND',
              people: 3,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'QA',
              people: 2,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'DEVOPS',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'PM',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'BA',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'SOLUTION_ARCHITECT',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
            {
              role: 'UI_UX',
              people: 1,
              productiveHoursPerDay: 6.5,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            },
          ],
          expectedVersion: estimate.recordVersion,
        })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    let current = withTeam;

    if (current.blockers.some((blocker) => blocker.kind === 'unacknowledged_risk')) {
      current = (
        await session.agent
          .post(ESTIMATION_ROUTES.acknowledgeRisk)
          .set('x-csrf-token', session.csrf)
          .send({ acknowledged: true, expectedVersion: current.recordVersion })
          .expect(201)
      ).body.snapshot as EstimateSnapshot;
    }

    const approved = (
      await session.agent
        .post(ESTIMATION_ROUTES.approve)
        .set('x-csrf-token', session.csrf)
        .send({ acknowledgedAiAssistance: true, expectedVersion: current.recordVersion })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    expect(approved.status).toBe('APPROVED');

    /* An approved estimate refuses edits. */
    await session.agent
      .patch(ESTIMATION_ROUTES.estimateUnit(features(approved)[0]!.id))
      .set('x-csrf-token', session.csrf)
      .send({ effort: { BACKEND: 5 }, expectedVersion: approved.recordVersion })
      .expect(409);

    const reopened = (
      await session.agent
        .post(ESTIMATION_ROUTES.reopen)
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Scope grew.', expectedVersion: approved.recordVersion })
        .expect(200)
    ).body.snapshot as EstimateSnapshot;

    expect(reopened.version).toBe(approved.version + 1);
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.estimates.length).toBe(approved.estimates.length);

    const old = await session.agent
      .get(ESTIMATION_ROUTES.version(String(approved.version)))
      .expect(200);

    expect((old.body as EstimateSnapshot).status).toBe('SUPERSEDED');
    expect((old.body as EstimateSnapshot).approvedAt).toBeDefined();
    expect((old.body as EstimateSnapshot).totalEffort.expected).toBe(approved.totalEffort.expected);
  }, 240_000);

  /* --------------------------------------------------- 10. negatives */

  it('refuses an estimate request from another project', async () => {
    const { session, estimate } = await estimatedProject(WEB);
    const unitId = features(estimate)[0]!.id;

    const other = await newProject(WEB);

    await other.agent.get(ESTIMATION_ROUTES.estimate).expect(200);

    const refusal = await other.agent
      .patch(ESTIMATION_ROUTES.estimateUnit(unitId))
      .set('x-csrf-token', other.csrf)
      .send({ effort: { BACKEND: 1 }, expectedVersion: 0 })
      .expect(404);

    expect(JSON.stringify(refusal.body)).toContain('ESTIMATE_UNIT_NOT_FOUND');

    /* And the original is untouched. */
    expect((await readEstimate(session)).totalEffort.expected).toBe(estimate.totalEffort.expected);
  }, 180_000);

  it('still refuses a hosted inference endpoint', async () => {
    /*
     * Phase 4's endpoint hardening is shared, not reimplemented. This confirms
     * the wiring: nothing in the estimation module reaches for its own HTTP
     * client, so the same 33 vendor domains are refused.
     */
    const { EstimationAiService } = await import('../src/estimation/estimation-ai.service');
    const source = EstimationAiService.toString();

    expect(source).not.toContain('node:https');
    expect(source).not.toContain('fetch(');
  });

  it('documents every Phase 6 endpoint in the OpenAPI document', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const paths = Object.keys((response.body as { paths: Record<string, unknown> }).paths);

    for (const route of [
      ESTIMATION_ROUTES.estimate,
      ESTIMATION_ROUTES.versions,
      ESTIMATION_ROUTES.run,
      ESTIMATION_ROUTES.currentRun,
      ESTIMATION_ROUTES.estimates,
      ESTIMATION_ROUTES.dependencies,
      ESTIMATION_ROUTES.calendar,
      ESTIMATION_ROUTES.team,
      ESTIMATION_ROUTES.existingSystem,
      ESTIMATION_ROUTES.recalculateSchedule,
      ESTIMATION_ROUTES.acknowledgeRisk,
      ESTIMATION_ROUTES.approve,
      ESTIMATION_ROUTES.reopen,
    ]) {
      expect(paths).toContain(route);
    }

    expect(paths).toContain('/api/v1/projects/current/estimation/estimates/{estimateId}');
    expect(paths).toContain('/api/v1/projects/current/estimation/estimates/{estimateId}/reset');
    expect(paths).toContain('/api/v1/projects/current/estimation/dependencies/{dependencyId}');
    expect(paths).toContain('/api/v1/projects/current/estimation/versions/{version}');
  });
});
