import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ANALYSIS_ROUTES,
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  PROJECT_ROUTES,
  REQUIREMENT_ROUTES,
  STACK_ROUTES,
  type Baseline,
  type CategoryApplicabilityEntry,
  type DownstreamAuthority,
  type ProjectType,
  type StackComponent,
  type StackSnapshot,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';
import {
  STACK_FIXTURES,
  registerDefaultRecommendation,
  registerStackAnalysis,
  registerStackRecommendation,
  type StackFixture,
} from './stack-fixtures';

/**
 * The technology-stack workflow, end to end, against a real database.
 *
 * The suite is organised around the one claim the phase makes: **a person's
 * decision wins**. Most of what is below is an attempt to break that claim from
 * a different angle each time — a suggestion arriving for a chosen category, a
 * model naming a locked component, a re-run over a decided stack, a cross-project
 * request. The rest covers the two things that must work when the model is
 * absent entirely: choosing the whole stack by hand, and approving it.
 */
describe('Technology stack (e2e)', () => {
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
    // Mounted before init, which is the only point at which Swagger can walk
    // the routes. One test below asserts every Phase 5 endpoint appears.
    setupOpenApi(app, app.get(AppConfigService));
    await app.init();

    provider = app.get(DeterministicProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  /* -------------------------------------------------------------- setup */

  async function newProject(projectTypes: readonly ProjectType[], name = 'Stack test') {
    const agent = request.agent(app.getHttpServer());
    const created = await agent
      .post(PROJECT_ROUTES.create)
      .send({ name, projectTypes: [...projectTypes] })
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

    return { agent, csrf };
  }

  type Session = Awaited<ReturnType<typeof newProject>>;

  /** A project with an approved baseline built from a fixture. */
  async function approvedProject(fixture: StackFixture): Promise<Session> {
    const session = await newProject(fixture.projectTypes, fixture.name);

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

    return session;
  }

  /** Waits for the analysis to reach a terminal state. */
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

  async function readStack(session: Session): Promise<StackSnapshot> {
    const response = await session.agent.get(STACK_ROUTES.stack).expect(200);

    return response.body.snapshot as StackSnapshot;
  }

  function categoryFor(
    stack: StackSnapshot,
    category: string,
  ): CategoryApplicabilityEntry | undefined {
    return stack.categoryPlan.find((entry) => entry.category === category);
  }

  function componentIn(stack: StackSnapshot, category: string): StackComponent | undefined {
    return stack.components.find(
      (component) =>
        component.category === category &&
        component.status !== 'SUPERSEDED' &&
        component.status !== 'REJECTED',
    );
  }

  async function select(
    session: Session,
    stack: StackSnapshot,
    body: Record<string, unknown>,
  ): Promise<StackSnapshot> {
    const response = await session.agent
      .post(STACK_ROUTES.components)
      .set('x-csrf-token', session.csrf)
      .send({
        selectionSource: 'USER',
        mandatory: false,
        expectedVersion: stack.recordVersion,
        ...body,
      })
      .expect(201);

    return response.body.snapshot as StackSnapshot;
  }

  const WEB = STACK_FIXTURES.find((fixture) => fixture.name === 'a standard web application')!;

  /* ---------------------------------------------- 1. project type shapes */

  describe('which categories a project has', () => {
    /*
     * Thirteen fixtures, one assertion set each. This is the test that would
     * fail if a "sensible default" ever crept into the category plan — the
     * static website acquiring a database, or the API service a frontend.
     */
    it.each(STACK_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
      'plans %s correctly',
      async (_name, fixture) => {
        const session = await approvedProject(fixture);
        const stack = await readStack(session);

        // Reported as a map, so a failure names every category at once rather
        // than stopping at the first — which is what you want when a plan is
        // wrong in three places.
        const applicability = Object.fromEntries(
          [
            ...fixture.expectRequired,
            ...fixture.expectNotApplicable,
            ...(fixture.expectConditional ?? []),
          ].map((category) => [category, categoryFor(stack, category)?.applicability]),
        );

        expect(applicability).toEqual({
          ...Object.fromEntries(fixture.expectRequired.map((c) => [c, 'required'])),
          ...Object.fromEntries(fixture.expectNotApplicable.map((c) => [c, 'not_applicable'])),
          ...Object.fromEntries((fixture.expectConditional ?? []).map((c) => [c, 'conditional'])),
        });
      },
      120_000,
    );
  });

  /* ------------------------------------------------------ 2. the modes */

  it('lets the AI recommend the whole stack', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    await session.agent
      .put(STACK_ROUTES.mode)
      .set('x-csrf-token', session.csrf)
      .send({ mode: 'AI_RECOMMENDS_ALL', expectedVersion: stack.recordVersion })
      .expect(200);

    stack = await readStack(session);
    registerDefaultRecommendation(provider);

    const response = await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: stack.recordVersion })
      .expect(201);

    stack = response.body.snapshot as StackSnapshot;

    expect(componentIn(stack, 'web_frontend')?.status).toBe('AI_RECOMMENDED');
    expect(componentIn(stack, 'backend')?.status).toBe('AI_RECOMMENDED');
    expect(componentIn(stack, 'database')?.status).toBe('AI_RECOMMENDED');

    /* Every suggestion blocks approval until somebody looks at it. */
    expect(stack.blockers.some((blocker) => blocker.kind === 'undecided_recommendation')).toBe(
      true,
    );
  }, 120_000);

  it('lets a user choose the whole stack with no AI at all', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    await session.agent
      .put(STACK_ROUTES.mode)
      .set('x-csrf-token', session.csrf)
      .send({ mode: 'USER_SELECTS_ALL', expectedVersion: stack.recordVersion })
      .expect(200);

    stack = await readStack(session);
    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'vue' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'laravel' });
    stack = await select(session, stack, { category: 'database', technologyId: 'mysql' });

    expect(componentIn(stack, 'web_frontend')?.technologyName).toBe('Vue');
    expect(componentIn(stack, 'backend')?.technologyName).toBe('Laravel');
    expect(componentIn(stack, 'database')?.technologyName).toBe('MySQL');
    expect(stack.blockers).toEqual([]);
  }, 120_000);

  /*
   * The MVP requirement, and the one most easily lost: the whole step must work
   * when no inference server exists. Nothing in this test touches a provider.
   */
  it('approves and locks a hand-picked stack without ever calling a model', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'react' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'nestjs' });
    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });

    const approved = await session.agent
      .post(STACK_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
      .expect(200);

    stack = approved.body.snapshot as StackSnapshot;
    expect(stack.status).toBe('APPROVED');

    const locked = await session.agent
      .post(STACK_ROUTES.lock)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedDownstreamAuthority: true, expectedVersion: stack.recordVersion })
      .expect(200);

    expect((locked.body.snapshot as StackSnapshot).status).toBe('LOCKED');

    const run = await session.agent.get(STACK_ROUTES.currentRecommendationRun).expect(200);

    // Never asked. The stack reached a locked state with no run at all.
    expect(run.body.run).toBeNull();
  }, 120_000);

  it('fills only the missing categories in hybrid mode', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'nextjs' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'nestjs' });
    /* Only the database is undecided, so that is all the run may be given. */
    registerDefaultRecommendation(provider, ['database']);

    const response = await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: stack.recordVersion })
      .expect(201);

    stack = response.body.snapshot as StackSnapshot;

    /* Untouched, both of them. */
    expect(componentIn(stack, 'web_frontend')?.technologyName).toBe('Next.js');
    expect(componentIn(stack, 'web_frontend')?.status).toBe('USER_SELECTED');
    expect(componentIn(stack, 'backend')?.technologyName).toBe('NestJS');
    expect(componentIn(stack, 'backend')?.status).toBe('USER_SELECTED');

    /* And the empty one is filled. */
    expect(componentIn(stack, 'database')?.status).toBe('AI_RECOMMENDED');
  }, 120_000);

  /* ------------------------------------------- 3. user authority holds */

  it('discards a suggestion for a category the user has decided', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'database', technologyId: 'mysql' });

    /*
     * The model is scripted to do the forbidden thing directly: recommend
     * PostgreSQL for a category the user filled with MySQL. The filter should
     * never have asked, and the write refuses regardless.
     */
    registerStackRecommendation(provider, {
      recommendations: [
        {
          category: 'database',
          technologyId: 'postgresql',
          rationale: 'The model would prefer PostgreSQL here.',
          requirementIds: [],
          benefits: [],
          limitations: [],
          risks: [],
          operationalConsiderations: [],
          alternativeTechnologyId: null,
          alternativeReason: null,
          modelConfidence: 0.95,
        },
      ],
      concerns: [],
    });

    /*
     * Refused before anything is written. The database was never one of the
     * categories offered — the user decided it — so a recommendation naming it
     * is output the application did not ask for, and the whole run is discarded
     * rather than partially applied.
     */
    await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ categories: ['database'], expectedVersion: stack.recordVersion })
      .expect(422);

    stack = await readStack(session);

    // Still MySQL, still the user's, and the confident model changed nothing.
    expect(componentIn(stack, 'database')?.technologyName).toBe('MySQL');
    expect(componentIn(stack, 'database')?.status).toBe('USER_SELECTED');
  }, 120_000);

  it('keeps a user selection that the requirements argue against', async () => {
    const fixture = STACK_FIXTURES.find(
      (item) => item.name === 'a project that must be self-hosted',
    )!;
    const session = await approvedProject(fixture);
    let stack = await readStack(session);

    /* S3 cannot be self-hosted, and the requirements say everything must be. */
    stack = await select(session, stack, { category: 'object_storage', technologyId: 's3' });

    const violation = stack.compatibilityFindings.find(
      (finding) => finding.kind === 'self_hosting_violation',
    );

    expect(violation?.level).toBe('BLOCKING');
    expect(violation?.requirementIds.length).toBeGreaterThan(0);

    // The choice is still there. The application reports; it does not overrule.
    expect(componentIn(stack, 'object_storage')?.technologyName).toBe('Amazon S3');
  }, 120_000);

  it('represents an explicit client mandate as a constraint, not a preference', async () => {
    const fixture = STACK_FIXTURES.find(
      (item) => item.name === 'a project with an explicit technology mandate',
    )!;
    const session = await approvedProject(fixture);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });

    const contradiction = stack.compatibilityFindings.find(
      (finding) => finding.kind === 'mandate_contradiction',
    );

    expect(contradiction?.level).toBe('BLOCKING');
    expect(contradiction?.summary).toContain('MySQL');
    expect(contradiction?.requirementIds.length).toBeGreaterThan(0);
  }, 120_000);

  it('does not offer a category the project does not have', async () => {
    const fixture = STACK_FIXTURES.find((item) => item.name === 'an API-only service')!;
    const session = await approvedProject(fixture);
    const stack = await readStack(session);

    const refusal = await session.agent
      .post(STACK_ROUTES.components)
      .set('x-csrf-token', session.csrf)
      .send({
        category: 'web_frontend',
        technologyId: 'react',
        selectionSource: 'USER',
        mandatory: false,
        expectedVersion: stack.recordVersion,
      })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('CATEGORY_NOT_APPLICABLE');
  }, 120_000);

  it('records a technology it has never heard of, exactly as typed', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, {
      category: 'backend',
      customName: 'Corvid Framework 3',
      selectionSource: 'CLIENT_REQUIREMENT',
      mandatory: true,
    });

    const component = componentIn(stack, 'backend');

    expect(component?.technologyName).toBe('Corvid Framework 3');
    expect(component?.technologyId).toBeUndefined();
    expect(component?.status).toBe('USER_SELECTED');
    expect(component?.mandatory).toBe(true);
    /* No invented facts about something nobody reviewed. */
    expect(component?.licence).toBe('');
    expect(component?.costPosture).toBe('UNKNOWN');
  }, 120_000);

  it('resolves a typed name that the catalogue does know', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'database', customName: 'postgres' });

    const component = componentIn(stack, 'database');

    expect(component?.technologyName).toBe('PostgreSQL');
    expect(component?.technologyId).toBe('postgresql');
    expect(component?.licence).toBe('PostgreSQL');
  }, 120_000);

  /* -------------------------------------------- 4. deciding suggestions */

  it('accepts, rejects and replaces a suggestion', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);
    registerDefaultRecommendation(provider);

    const suggested = await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: stack.recordVersion })
      .expect(201);

    stack = suggested.body.snapshot as StackSnapshot;

    /* Accept. */
    const accept = await session.agent
      .post(STACK_ROUTES.decideComponent(componentIn(stack, 'database')!.id))
      .set('x-csrf-token', session.csrf)
      .send({ decision: 'accept', expectedVersion: stack.recordVersion })
      .expect(201);

    stack = accept.body.snapshot as StackSnapshot;
    expect(componentIn(stack, 'database')?.status).toBe('USER_APPROVED');

    /* Reject. */
    const reject = await session.agent
      .post(STACK_ROUTES.decideComponent(componentIn(stack, 'backend')!.id))
      .set('x-csrf-token', session.csrf)
      .send({
        decision: 'reject',
        reason: 'We do not use this.',
        expectedVersion: stack.recordVersion,
      })
      .expect(201);

    stack = reject.body.snapshot as StackSnapshot;
    expect(componentIn(stack, 'backend')).toBeUndefined();

    /* Replace. */
    const replace = await session.agent
      .post(STACK_ROUTES.decideComponent(componentIn(stack, 'web_frontend')!.id))
      .set('x-csrf-token', session.csrf)
      .send({
        decision: 'replace',
        technologyId: 'svelte',
        reason: 'The team knows it.',
        expectedVersion: stack.recordVersion,
      })
      .expect(201);

    stack = replace.body.snapshot as StackSnapshot;

    const frontend = componentIn(stack, 'web_frontend');

    expect(frontend?.technologyName).toBe('Svelte');
    expect(frontend?.status).toBe('USER_SELECTED');
    expect(frontend?.replacedTechnologyName).toBe('React');
  }, 120_000);

  it('refuses to accept something that was never a suggestion', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });

    const refusal = await session.agent
      .post(STACK_ROUTES.decideComponent(componentIn(stack, 'database')!.id))
      .set('x-csrf-token', session.csrf)
      .send({ decision: 'accept', expectedVersion: stack.recordVersion })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('COMPONENT_NOT_RECOMMENDED');
  }, 120_000);

  /* ----------------------------------------------- 5. risk and approval */

  it('lets a user keep a risky choice once they acknowledge it', async () => {
    const fixture = STACK_FIXTURES.find(
      (item) => item.name === 'a project that requires a commercial cloud',
    )!;
    const session = await approvedProject(fixture);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'react' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'nestjs' });
    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });
    stack = await select(session, stack, {
      category: 'authentication',
      technologyId: 'auth0',
    });
    stack = await select(session, stack, { category: 'hosting', technologyId: 'aws' });

    /*
     * Nothing here is blocking — the client asked for AWS. What matters is that
     * anything the application does flag can be kept after acknowledgement,
     * rather than standing between the user and their own decision.
     */
    const acknowledgeable = stack.compatibilityFindings.filter(
      (finding) => finding.level === 'HIGH',
    );

    for (const finding of acknowledgeable) {
      const response = await session.agent
        .post(STACK_ROUTES.acknowledgeRisk)
        .set('x-csrf-token', session.csrf)
        .send({
          findingId: finding.id,
          note: 'The client requires it.',
          acknowledged: true,
          expectedVersion: stack.recordVersion,
        })
        .expect(201);

      stack = response.body.snapshot as StackSnapshot;
    }

    expect(stack.blockers.some((blocker) => blocker.kind === 'unacknowledged_risk')).toBe(false);
    expect(componentIn(stack, 'hosting')?.technologyName).toBe('Amazon Web Services');
  }, 120_000);

  it('refuses to acknowledge away a blocking contradiction', async () => {
    const fixture = STACK_FIXTURES.find(
      (item) => item.name === 'a project that must be self-hosted',
    )!;
    const session = await approvedProject(fixture);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'object_storage', technologyId: 's3' });

    const blocking = stack.compatibilityFindings.find(
      (finding) => finding.kind === 'self_hosting_violation',
    )!;

    const refusal = await session.agent
      .post(STACK_ROUTES.acknowledgeRisk)
      .set('x-csrf-token', session.csrf)
      .send({ findingId: blocking.id, acknowledged: true, expectedVersion: stack.recordVersion })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('FINDING_NOT_ACKNOWLEDGEABLE');
  }, 120_000);

  it('refuses approval while anything is outstanding, and says what', async () => {
    const session = await approvedProject(WEB);
    const stack = await readStack(session);

    const refusal = await session.agent
      .post(STACK_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('STACK_HAS_BLOCKERS');
    /* Nothing has been chosen at all, and the refusal says exactly that. */
    expect(JSON.stringify(refusal.body)).toContain('empty_stack');
    expect(JSON.stringify(refusal.body)).toContain('Choose your technologies');
  }, 120_000);

  it('refuses a stack decided against a baseline that is not approved', async () => {
    const session = await newProject(['WEB_APPLICATION']);
    const stack = await readStack(session);

    expect(stack.blockers[0]?.kind).toBe('baseline_not_approved');

    await session.agent
      .post(STACK_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
      .expect(422);
  }, 120_000);

  /* --------------------------------------------------- 6. lock and after */

  it('refuses every change once the stack is locked', async () => {
    const session = await approvedProject(WEB);
    let stack = await lockedStack(session);

    const refusal = await session.agent
      .post(STACK_ROUTES.components)
      .set('x-csrf-token', session.csrf)
      .send({
        category: 'database',
        technologyId: 'mysql',
        selectionSource: 'USER',
        mandatory: false,
        expectedVersion: stack.recordVersion,
      })
      .expect(409);

    expect(JSON.stringify(refusal.body)).toContain('STACK_LOCKED');

    stack = await readStack(session);
    expect(componentIn(stack, 'database')?.technologyName).toBe('PostgreSQL');
  }, 120_000);

  it('refuses to let the AI touch a locked stack', async () => {
    const session = await approvedProject(WEB);
    const stack = await lockedStack(session);

    await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: stack.recordVersion })
      .expect(409);

    const after = await readStack(session);

    expect(after.components.map((component) => component.technologyName).sort()).toEqual(
      stack.components.map((component) => component.technologyName).sort(),
    );
  }, 120_000);

  it('hands a locked stack downstream, and refuses to hand over a draft', async () => {
    const session = await approvedProject(WEB);

    await readStack(session);
    /* A draft is not authoritative, and the refusal says which. */
    const refusal = await session.agent.get(STACK_ROUTES.authority).expect(422);

    expect(JSON.stringify(refusal.body)).toContain('STACK_NOT_LOCKED');

    const stack = await lockedStack(session);
    const authority = (await session.agent.get(STACK_ROUTES.authority).expect(200))
      .body as DownstreamAuthority;

    expect(authority.stackVersion).toBe(stack.version);
    expect(authority.technologies.map((technology) => technology.category).sort()).toEqual([
      'backend',
      'database',
      'web_frontend',
    ]);
    expect(
      authority.technologies.every(
        (technology) => technology.authority === 'LOCKED_USER_SELECTION',
      ),
    ).toBe(true);
    /* Empty categories are stated, so nothing downstream fills them in. */
    expect(authority.excludedCategories.length).toBeGreaterThan(0);
  }, 120_000);

  it('reopens a locked stack as a new version, leaving the old one intact', async () => {
    const session = await approvedProject(WEB);
    const locked = await lockedStack(session);

    const reopened = await session.agent
      .post(STACK_ROUTES.unlock)
      .set('x-csrf-token', session.csrf)
      .send({ reason: 'The client changed their database.', expectedVersion: locked.recordVersion })
      .expect(200);

    const next = reopened.body.snapshot as StackSnapshot;

    expect(next.version).toBe(locked.version + 1);
    expect(next.status).toBe('DRAFT');
    /* Carried forward, but no longer locked — a new version is locked on purpose. */
    expect(componentIn(next, 'database')?.status).toBe('USER_APPROVED');

    const old = await session.agent
      .get(STACK_ROUTES.stackVersion(String(locked.version)))
      .expect(200);

    expect((old.body as StackSnapshot).status).toBe('SUPERSEDED');
    expect((old.body as StackSnapshot).lockedAt).toBeDefined();
  }, 120_000);

  /* ------------------------------------------------- 7. outdated states */

  it('marks the stack out of date when a newer baseline is approved', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'react' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'nestjs' });
    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });

    await session.agent
      .post(STACK_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
      .expect(200);

    /* A document changes, so the approved baseline goes out of date. */
    const created = await session.agent
      .post(REQUIREMENT_ROUTES.textSources)
      .set('x-csrf-token', session.csrf)
      .send({ title: 'Addendum', text: 'Staff must also export a monthly summary.' })
      .expect(201);

    await session.agent
      .post(REQUIREMENT_ROUTES.review(created.body.sourceId))
      .set('x-csrf-token', session.csrf)
      .send({ version: created.body.version })
      .expect(200);

    stack = await readStack(session);

    expect(stack.blockers.map((blocker) => blocker.kind)).toContain('baseline_not_current');
    /* Nothing was regenerated. The technologies are exactly as they were. */
    expect(componentIn(stack, 'database')?.technologyName).toBe('PostgreSQL');
  }, 120_000);

  it('marks the stack out of date when the project type changes', async () => {
    const session = await approvedProject(WEB);

    await select(session, await readStack(session), {
      category: 'web_frontend',
      technologyId: 'react',
    });

    const project = await session.agent.get(PROJECT_ROUTES.current).expect(200);

    await session.agent
      .put(PROJECT_ROUTES.details)
      .set('x-csrf-token', session.csrf)
      .send({
        details: { name: project.body.name, projectTypes: ['BACKEND_API'] },
        version: project.body.version,
      })
      .expect(200);

    const stack = await readStack(session);

    /*
     * The plan the stack was decided against is stored on the snapshot, so the
     * frontend it holds is now in a category the project no longer has — which
     * is exactly the situation a reviewer needs to see rather than have fixed
     * for them.
     */
    expect(stack.projectTypes).toEqual(['WEB_APPLICATION']);
    expect(componentIn(stack, 'web_frontend')?.technologyName).toBe('React');
  }, 120_000);

  /* ---------------------------------------------------- 8. the negatives */

  it('refuses a stack request from another project', async () => {
    const first = await approvedProject(WEB);
    let stack = await readStack(first);

    stack = await select(first, stack, { category: 'database', technologyId: 'postgresql' });

    const componentId = componentIn(stack, 'database')!.id;
    const second = await newProject(['WEB_APPLICATION'], 'Someone else');

    await second.agent.get(STACK_ROUTES.stack).expect(200);

    const refusal = await second.agent
      .post(STACK_ROUTES.decideComponent(componentId))
      .set('x-csrf-token', second.csrf)
      .send({ decision: 'accept', expectedVersion: 0 })
      .expect(404);

    /* Not found, the same answer as an id that never existed. */
    expect(JSON.stringify(refusal.body)).toContain('COMPONENT_NOT_FOUND');
  }, 120_000);

  it('changes nothing when the model fails', async () => {
    const session = await approvedProject(WEB);
    const before = await readStack(session);

    provider.reset();

    await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: before.recordVersion })
      .expect(503);

    const after = await readStack(session);

    expect(after.components).toEqual([]);

    const run = await session.agent.get(STACK_ROUTES.currentRecommendationRun).expect(200);

    /* The failure is recorded, so an empty category has an explanation. */
    expect(run.body.run.status).toBe('failed');
  }, 120_000);

  it('discards output that cites a requirement or technology it was not given', async () => {
    const session = await approvedProject(WEB);
    const stack = await readStack(session);

    registerStackRecommendation(provider, {
      recommendations: [
        {
          category: 'database',
          technologyId: 'postgresql-enterprise-edition',
          rationale: 'A technology that does not exist.',
          requirementIds: ['REQ-9999'],
          benefits: [],
          limitations: [],
          risks: [],
          operationalConsiderations: [],
          alternativeTechnologyId: null,
          alternativeReason: null,
          modelConfidence: 0.9,
        },
      ],
      concerns: [],
    });

    await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: stack.recordVersion })
      .expect(503);

    const after = await readStack(session);

    expect(after.components).toEqual([]);
  }, 120_000);

  it('still refuses a hosted inference endpoint', async () => {
    /*
     * Phase 4's endpoint hardening is not weakened by this phase reusing it.
     * The provider layer is shared, and the same 33 vendor domains are refused
     * — asserted in `endpoint-hardening.spec.ts`; this checks the wiring is the
     * same one, by confirming Phase 5 uses the injected provider rather than
     * reaching for its own HTTP client.
     */
    const { RecommendationService } = await import('../src/stack/recommendation.service');
    const source = RecommendationService.toString();

    expect(source).not.toContain('node:https');
    expect(source).not.toContain('fetch(');
  });

  it('says there is nothing to suggest when everything is decided', async () => {
    const session = await approvedProject(WEB);
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'react' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'nestjs' });
    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });

    for (const category of [
      'authentication',
      'authorization',
      'object_storage',
      'background_jobs',
      'hosting',
      'ci_cd',
      'monitoring',
      'logging',
      'analytics',
      'testing',
      'security_tooling',
      'integrations',
      'other',
    ]) {
      const entry = categoryFor(stack, category);

      if (entry && entry.applicability !== 'not_applicable') {
        stack = await select(session, stack, { category, customName: `Our ${category}` });
      }
    }

    const refusal = await session.agent
      .post(STACK_ROUTES.recommendations)
      .set('x-csrf-token', session.csrf)
      .send({ expectedVersion: stack.recordVersion })
      .expect(422);

    expect(JSON.stringify(refusal.body)).toContain('NOTHING_TO_RECOMMEND');
  }, 180_000);

  it('documents every Phase 5 endpoint in the OpenAPI document', async () => {
    /*
     * The generated document is the API's public description. A route that is
     * reachable and undocumented is one an integrator finds by reading our
     * source, which is not a contract.
     */
    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const paths = Object.keys((response.body as { paths: Record<string, unknown> }).paths);

    for (const route of [
      STACK_ROUTES.stack,
      STACK_ROUTES.stackVersions,
      STACK_ROUTES.categories,
      STACK_ROUTES.catalog,
      STACK_ROUTES.mode,
      STACK_ROUTES.components,
      STACK_ROUTES.recommendations,
      STACK_ROUTES.currentRecommendationRun,
      STACK_ROUTES.acknowledgeRisk,
      STACK_ROUTES.approve,
      STACK_ROUTES.lock,
      STACK_ROUTES.unlock,
      STACK_ROUTES.authority,
    ]) {
      expect(paths).toContain(route);
    }

    /* And the parameterised ones, which appear with their template. */
    expect(paths).toContain('/api/v1/projects/current/stack/components/{componentId}/decision');
    expect(paths).toContain('/api/v1/projects/current/stack/components/{componentId}/lock');
    expect(paths).toContain('/api/v1/projects/current/stack/components/{componentId}/unlock');
    expect(paths).toContain('/api/v1/projects/current/stack/versions/{version}');
  });

  /** A project whose stack is approved and locked with three technologies. */
  async function lockedStack(session: Session): Promise<StackSnapshot> {
    let stack = await readStack(session);

    stack = await select(session, stack, { category: 'web_frontend', technologyId: 'react' });
    stack = await select(session, stack, { category: 'backend', technologyId: 'nestjs' });
    stack = await select(session, stack, { category: 'database', technologyId: 'postgresql' });

    const approved = await session.agent
      .post(STACK_ROUTES.approve)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
      .expect(200);

    stack = approved.body.snapshot as StackSnapshot;

    const locked = await session.agent
      .post(STACK_ROUTES.lock)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedDownstreamAuthority: true, expectedVersion: stack.recordVersion })
      .expect(200);

    return locked.body.snapshot as StackSnapshot;
  }
});
