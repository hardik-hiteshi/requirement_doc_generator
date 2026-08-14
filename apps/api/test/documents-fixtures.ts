import {
  ANALYSIS_ROUTES,
  CSRF_COOKIE,
  ESTIMATION_ROUTES,
  PROJECT_ROUTES,
  REQUIREMENT_ROUTES,
  STACK_ROUTES,
  type Baseline,
  type EstimateSnapshot,
  type StackSnapshot,
} from '@wdrg/contracts';
import request from 'supertest';
import type { Server } from 'node:http';

import type { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { registerStackAnalysis } from './stack-fixtures';

/**
 * Project shapes Phase 7 has to get right, and the long setup they all need.
 *
 * A document is the *end* of the chain, so every fixture here walks the whole of
 * it: requirements in, analysed, baseline approved, stack locked, estimate run and
 * approved. That length is the point — a Feature Listing quoting hours nobody
 * signed off would be the failure this phase exists to prevent, so the tests
 * cannot take a shortcut past the approvals.
 *
 * The hard cases are the ones where a plausible implementation looks fine:
 *
 * - **an API-only project has no screens**, and a row must say so with an empty
 *   cell rather than inventing "Payments Screen";
 * - **a mobile project has mobile hours**, which have no CSV column of their own
 *   and must survive into "Other Roles" rather than being dropped;
 * - **an explicit non-functional requirement** must appear with its stated figure
 *   and nothing added;
 * - **an explicit out-of-scope statement** must survive into the document, because
 *   that sentence is what protects both sides;
 * - **a confirmed clarification** is part of the agreement and belongs in the
 *   document.
 */

export interface DocumentFixture {
  readonly name: string;
  readonly projectTypes: readonly string[];
  readonly brief: readonly string[];
  readonly stack: readonly { readonly category: string; readonly technologyId: string }[];
  /** Roles the estimate must price, so the CSV projection can be asserted. */
  readonly expectRoles?: readonly string[];
  /** True when every Screen cell must be empty. */
  readonly noInterface?: boolean;
  /**
   * Leave the team unstaffed.
   *
   * The common path supplies one, because most assertions want measured capacity.
   * This shape exercises the other half: Phase 6 derives the staffing the work
   * would need and schedules against it, so a plan with no team still has a
   * duration for a document to quote.
   */
  readonly withoutTeam?: boolean;
  /**
   * The project's timeline, when the default weeks-based one is not the point.
   *
   * Export has to preserve a fixed deadline exactly and invent one nowhere, and that
   * cannot be asserted against a project whose timeline never had a date in it.
   */
  readonly timeline?: Record<string, unknown>;
}

const WEB_STACK = [
  { category: 'web_frontend', technologyId: 'react' },
  { category: 'backend', technologyId: 'nestjs' },
  { category: 'database', technologyId: 'postgresql' },
];

const API_STACK = [
  { category: 'backend', technologyId: 'nestjs' },
  { category: 'database', technologyId: 'postgresql' },
];

const MOBILE_STACK = [
  { category: 'mobile_framework', technologyId: 'react-native' },
  { category: 'backend', technologyId: 'nestjs' },
  { category: 'database', technologyId: 'postgresql' },
];

export const DOCUMENT_FIXTURES: readonly DocumentFixture[] = [
  {
    name: 'a web application',
    projectTypes: ['WEB_APPLICATION'],
    brief: [
      'Staff must sign in and record their weekly timesheets on a weekly grid screen.',
      'A manager must approve every timesheet before it is exported.',
      'The system must keep a history of every approval.',
    ],
    stack: WEB_STACK,
  },
  {
    name: 'an API-only service',
    projectTypes: ['BACKEND_API'],
    brief: [
      'The service must expose an endpoint that accepts a timesheet submission.',
      'The service must reject a submission whose week has already been approved.',
    ],
    stack: API_STACK,
    noInterface: true,
  },
  {
    name: 'a mobile application',
    projectTypes: ['CROSS_PLATFORM_MOBILE'],
    brief: [
      'A field engineer must record hours from the mobile app while offline.',
      'The app must sync recorded hours when a connection returns.',
    ],
    stack: MOBILE_STACK,
  },
  {
    name: 'a project with an explicit non-functional requirement',
    projectTypes: ['WEB_APPLICATION'],
    brief: [
      'Staff must record their weekly timesheets.',
      'The timesheet list screen must load within 3 seconds for up to 500 records.',
    ],
    stack: WEB_STACK,
  },
  {
    name: 'a project with no team supplied',
    projectTypes: ['WEB_APPLICATION'],
    brief: [
      'Staff must record their weekly timesheets on a weekly grid screen.',
      'A manager must approve every timesheet before it is exported.',
    ],
    stack: WEB_STACK,
    withoutTeam: true,
  },
  {
    name: 'a project with explicit out-of-scope items',
    projectTypes: ['WEB_APPLICATION'],
    brief: [
      'Staff must record their weekly timesheets.',
      'Payroll processing is out of scope and will not be included.',
    ],
    stack: WEB_STACK,
  },
];

export function documentFixture(name: string): DocumentFixture {
  const fixture = DOCUMENT_FIXTURES.find((entry) => entry.name === name);

  if (!fixture) {
    throw new Error(`No document fixture named "${name}".`);
  }

  return fixture;
}

export interface FixtureSession {
  readonly agent: ReturnType<typeof request.agent>;
  readonly csrf: string;
}

/**
 * A project with an approved baseline, a locked stack and an **approved**
 * estimate — everything Phase 7 needs before it will write anything.
 */
export async function approvedEstimateProject(
  server: Server,
  provider: DeterministicProvider,
  fixture: DocumentFixture,
): Promise<FixtureSession> {
  const agent = request.agent(server);
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

  const session: FixtureSession = { agent, csrf };

  /* A timeline, because estimation refuses without one. */
  await agent
    .put(PROJECT_ROUTES.timeline)
    .set('x-csrf-token', csrf)
    .send({ timeline: fixture.timeline ?? { mode: 'WEEKS', weeks: 12 }, version: 0 })
    .expect(200);

  /* Requirements, reviewed. */
  const source = await agent
    .post(REQUIREMENT_ROUTES.textSources)
    .set('x-csrf-token', csrf)
    .send({ title: 'Client brief', text: fixture.brief.join('\n') })
    .expect(201);

  const blocks = source.body.effectiveContent.blocks as { id: string; text: string }[];

  await agent
    .post(REQUIREMENT_ROUTES.review(source.body.sourceId))
    .set('x-csrf-token', csrf)
    .send({ version: source.body.version })
    .expect(200);

  registerStackAnalysis(provider, blocks);

  await agent
    .post(ANALYSIS_ROUTES.runs)
    .set('x-csrf-token', csrf)
    .send({ preserveUserDecisions: true })
    .expect(202);

  await settleAnalysis(session);

  const baseline = (await agent.get(ANALYSIS_ROUTES.baseline).expect(200)).body
    .baseline as Baseline;

  await agent
    .post(ANALYSIS_ROUTES.approveBaseline)
    .set('x-csrf-token', csrf)
    .send({ acknowledgedAiAssistance: true, expectedVersion: baseline.recordVersion })
    .expect(201);

  /* A locked stack. */
  let stack = (await agent.get(STACK_ROUTES.stack).expect(200)).body.snapshot as StackSnapshot;

  for (const component of fixture.stack) {
    const response = await agent
      .post(STACK_ROUTES.components)
      .set('x-csrf-token', csrf)
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

  const approvedStack = await agent
    .post(STACK_ROUTES.approve)
    .set('x-csrf-token', csrf)
    .send({ acknowledgedAiAssistance: true, expectedVersion: stack.recordVersion })
    .expect(200);

  await agent
    .post(STACK_ROUTES.lock)
    .set('x-csrf-token', csrf)
    .send({
      acknowledgedDownstreamAuthority: true,
      expectedVersion: (approvedStack.body.snapshot as StackSnapshot).recordVersion,
    })
    .expect(200);

  /* An estimate, run deterministically. */
  const initial = (await agent.get(ESTIMATION_ROUTES.estimate).expect(200)).body
    .snapshot as EstimateSnapshot;

  const estimated = (
    await agent
      .post(ESTIMATION_ROUTES.run)
      .set('x-csrf-token', csrf)
      .send({ useAi: false, expectedVersion: initial.recordVersion })
      .expect(201)
  ).body.snapshot as EstimateSnapshot;

  /*
   * A team, so capacity is measured rather than derived.
   *
   * Set after the run, because the roles a project may be staffed with come from its
   * own locked stack — staffing a role this project has no work for is refused — and
   * the run is what reveals which roles were priced.
   *
   * A schedule does not depend on this. Phase 6 derives the staffing the work would
   * need when no team is supplied and schedules against it, which the `withoutTeam`
   * fixture exercises. Supplying one here turns recommended staffing into measured
   * utilisation, which is what most assertions in the document suites want to read.
   */
  const roles = [...new Set(estimated.estimates.flatMap((unit) => Object.keys(unit.effort)))];

  const staffed = fixture.withoutTeam
    ? estimated
    : ((
        await agent
          .put(ESTIMATION_ROUTES.team)
          .set('x-csrf-token', csrf)
          .send({
            lines: roles.map((role) => ({
              role,
              people: 1,
              productiveHoursPerDay: 6,
              workingDaysPerWeek: 5,
              availability: 1,
              availableFromDay: 0,
            })),
            expectedVersion: estimated.recordVersion,
          })
          .expect(200)
      ).body.snapshot as EstimateSnapshot);

  await agent
    .post(ESTIMATION_ROUTES.approve)
    .set('x-csrf-token', csrf)
    .send({ acknowledgedAiAssistance: true, expectedVersion: staffed.recordVersion })
    .expect(200);

  return session;
}

async function settleAnalysis(session: FixtureSession): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await session.agent.get(ANALYSIS_ROUTES.currentRun).expect(200);
    const status = (current.body as { status?: string } | null)?.status;

    if (!status || ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Scripted document responses, so the AI path is deterministic.
 *
 * The `document.section` response deliberately contains only supported prose: a
 * fixture that returned an invented uptime figure would make the forbidden-content
 * check fire on every AI test, which is a different test.
 */
export function registerDocumentGeneration(
  provider: DeterministicProvider,
  requirementKeys: readonly string[],
  sectionKeys: readonly string[],
): void {
  provider.register(
    'document.plan',
    JSON.stringify({
      sections: sectionKeys.map((key) => ({
        key,
        requirementIds: [...requirementKeys],
        hasEvidence: true,
        omittedReason: null,
      })),
      unassignedRequirementIds: [],
    }),
  );

  provider.register(
    'document.section',
    JSON.stringify({
      body: 'The system records weekly timesheets and requires a manager to approve each one before it is exported. Every approval is kept with its author and time.',
      requirementIds: [...requirementKeys],
      unsupportedStatements: [],
    }),
  );

  provider.register(
    'document.features',
    JSON.stringify({
      features: requirementKeys.map((key, index) => ({
        module: 'Timesheets',
        submodule: index === 0 ? 'Entry' : 'Approval',
        screen: index === 0 ? 'Weekly grid' : 'Approval queue',
        description: 'A user performs the action | The system records what happened',
        requirementIds: [key],
      })),
    }),
  );

  provider.register('document.validate', JSON.stringify({ findings: [] }));
}

/** A model that invents a commitment, for the unsupported-statement tests. */
export function registerInventedContent(
  provider: DeterministicProvider,
  requirementKeys: readonly string[],
): void {
  provider.register(
    'document.section',
    JSON.stringify({
      body: 'The platform is GDPR compliant and provides 99.9% uptime for up to 10,000 concurrent users.',
      requirementIds: [...requirementKeys],
      unsupportedStatements: [],
    }),
  );
}

/**
 * A model that tries to set hours.
 *
 * `document.features` has no effort field, so this response fails validation and
 * the run falls back to the wording already on the rows. Registered by the test
 * that proves an attempted effort mutation cannot land.
 */
export function registerEffortMutatingFeatures(
  provider: DeterministicProvider,
  requirementKeys: readonly string[],
): void {
  provider.register(
    'document.features',
    JSON.stringify({
      features: requirementKeys.map((key) => ({
        module: 'Hijacked',
        submodule: '',
        screen: '',
        description: 'Rewritten by a model that also tried to reprice the work.',
        requirementIds: [key],
        /* None of these exist in the schema. All of them are refused. */
        effort: { BACKEND: 999, FRONTEND: 999, QA: 999 },
        totalHours: 2997,
        estimatedHours: 2997,
      })),
    }),
  );
}

/** A model that renames a module, which is a legitimate correction outcome. */
export function registerRenamedModule(
  provider: DeterministicProvider,
  requirementKeys: readonly string[],
  module: string,
): void {
  provider.register(
    'document.features',
    JSON.stringify({
      features: requirementKeys.map((key) => ({
        module,
        submodule: '',
        screen: '',
        description: 'A user performs the action | The system records what happened',
        requirementIds: [key],
      })),
    }),
  );
}

/* ================================================ Phase 8 fixtures ======= */

/**
 * A model that writes acceptance conditions.
 *
 * Deliberately plain and observable, because that is what a good one looks like:
 * something a reader could watch happen and agree had happened.
 */
export function registerAcceptanceCriteria(
  provider: DeterministicProvider,
  criteria: readonly {
    readonly featureId: string;
    readonly requirementIds: readonly string[];
    readonly given?: string;
    readonly when?: string;
    readonly then: string;
    readonly rule?: string;
  }[],
): void {
  const payload = JSON.stringify({
    criteria: criteria.map((criterion) => ({
      featureId: criterion.featureId,
      requirementIds: [...criterion.requirementIds],
      given: criterion.given ?? '',
      when: criterion.when ?? '',
      then: criterion.then,
      rule: criterion.rule ?? '',
    })),
  });

  provider.register('acceptance_criteria.generate', payload);
  provider.register('acceptance_criteria.regenerate', payload);
}

/**
 * A model that tries to add a commitment nobody agreed to.
 *
 * The single most expensive failure this document can have: a response time in an
 * acceptance condition is a service level, and it would be signed.
 */
export function registerThresholdInventingCriteria(
  provider: DeterministicProvider,
  featureId: string,
  requirementKey: string,
): void {
  const payload = JSON.stringify({
    criteria: [
      {
        featureId,
        requirementIds: [requirementKey],
        given: '',
        when: 'a timesheet is submitted',
        then: 'the system responds within 2 seconds and is 99.9% available',
        rule: '',
      },
    ],
  });

  provider.register('acceptance_criteria.generate', payload);
  provider.register('acceptance_criteria.regenerate', payload);
}

/** A model suggesting things the plan appears to be resting on. */
export function registerAssumptionCandidates(
  provider: DeterministicProvider,
  candidates: readonly {
    readonly statement: string;
    readonly category?: string;
    readonly requirementKeys?: readonly string[];
    readonly impact?: string;
  }[],
): void {
  provider.register(
    'assumptions.suggest',
    JSON.stringify({
      assumptions: candidates.map((candidate) => ({
        statement: candidate.statement,
        category: candidate.category ?? 'CLIENT',
        reasoning: 'The requirements describe the outcome but not who provides this.',
        requirementKeys: [...(candidate.requirementKeys ?? [])],
        impact: candidate.impact ?? 'MEDIUM',
        impactAreas: ['SCOPE'],
        impactIfFalse: 'The work would have to be added to the scope and estimated.',
        validationNeeded: 'Ask the client to confirm.',
      })),
    }),
  );
}

/**
 * A model that tries to return an assumption as though it were already agreed.
 *
 * Every one of these fields is absent from `assumptionCandidateSchema`, so the
 * response is rejected before storage rather than filtered afterwards.
 */
export function registerSelfConfirmingAssumption(
  provider: DeterministicProvider,
  statement: string,
): void {
  provider.register(
    'assumptions.suggest',
    JSON.stringify({
      assumptions: [
        {
          statement,
          category: 'CLIENT',
          reasoning: 'It seemed safe.',
          requirementKeys: [],
          impact: 'LOW',
          impactAreas: [],
          impactIfFalse: '',
          validationNeeded: '',
          /* None of these exist in the schema. */
          status: 'CONFIRMED',
          provenance: 'CLIENT_STATED',
          owner: 'The client',
          confirmedBy: 'USER',
        },
      ],
    }),
  );
}

/** A model that writes one SOW section. */
export function registerSowSection(
  provider: DeterministicProvider,
  key: string,
  body: string,
  requirementKeys: readonly string[] = [],
): void {
  provider.register(
    'sow.section.generate',
    JSON.stringify({ key, body, requirementKeys: [...requirementKeys] }),
  );
}

/**
 * A clarification question, so the assumption workflow has something to work on.
 *
 * Phase 4 raises these; Phase 8 reads the answer's `isAssumption` flag, which is a
 * decision a person made at the time rather than anything this phase infers.
 */
export function registerClarificationQuestion(
  provider: DeterministicProvider,
  question: string,
  requirementKey: string,
  blocking = false,
): void {
  provider.register(
    'clarification.generate',
    JSON.stringify({
      questions: [
        {
          id: 'q1',
          question,
          reason: 'The requirements do not say.',
          category: 'MISSING_DETAIL',
          impact: blocking ? 'BLOCKING' : 'IMPORTANT',
          itemIds: [requirementKey],
        },
      ],
    }),
  );
}
