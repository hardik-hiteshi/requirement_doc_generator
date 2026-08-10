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
    .send({ timeline: { mode: 'WEEKS', weeks: 12 }, version: 0 })
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

  /* An estimate, run deterministically and approved. */
  const initial = (await agent.get(ESTIMATION_ROUTES.estimate).expect(200)).body
    .snapshot as EstimateSnapshot;

  const estimated = (
    await agent
      .post(ESTIMATION_ROUTES.run)
      .set('x-csrf-token', csrf)
      .send({ useAi: false, expectedVersion: initial.recordVersion })
      .expect(201)
  ).body.snapshot as EstimateSnapshot;

  await agent
    .post(ESTIMATION_ROUTES.approve)
    .set('x-csrf-token', csrf)
    .send({ acknowledgedAiAssistance: true, expectedVersion: estimated.recordVersion })
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
