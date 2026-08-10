import type { ProjectType, Timeline } from '@wdrg/contracts';

/**
 * The fifteen project shapes Phase 6 has to get right.
 *
 * Each is a different answer to one of the three questions the phase asks:
 * *which roles does this project have?*, *does the work fit?*, and *what does
 * the schedule look like?* Getting any of them wrong produces a plan somebody
 * commits to and misses.
 *
 * The hard cases are the ones where a naive implementation looks fine:
 *
 * - **An API service has no frontend hours** — a frontend row on an API project
 *   is an invoice line for something nobody builds.
 * - **A static website has no backend hours**, for the same reason.
 * - **Two native platforms cost more than one cross-platform framework**, and
 *   the difference has to come from the locked stack rather than from the brief.
 * - **A no-team project reports required capacity rather than a fit**, because
 *   "it fits" would be a claim about a team nobody described.
 * - **No start date means relative days**, not a calendar with plausible dates
 *   nobody supplied.
 */

export interface EstimationFixture {
  readonly name: string;
  readonly projectTypes: readonly ProjectType[];
  readonly timeline: Timeline;
  readonly startDate?: { readonly mode: string; readonly date?: string };
  readonly source: { readonly title: string; readonly text: string };
  /** Locked-stack technology ids, by category. */
  readonly stack: readonly { readonly category: string; readonly technologyId: string }[];
  /** Roles that must appear in the effort breakdown. */
  readonly expectRoles?: readonly string[];
  /** Roles that must not appear at all. */
  readonly expectNoRoles?: readonly string[];
}

const WEB_STACK = [
  { category: 'web_frontend', technologyId: 'react' },
  { category: 'backend', technologyId: 'nestjs' },
  { category: 'database', technologyId: 'postgresql' },
];

export const ESTIMATION_FIXTURES: readonly EstimationFixture[] = [
  {
    name: 'a small static website',
    projectTypes: ['WEBSITE'],
    timeline: { mode: 'WEEKS', weeks: 4 },
    source: {
      title: 'Brochure site brief',
      text: [
        'The site must show five pages of company information.',
        'A page must display the team and their photographs.',
      ].join('\n'),
    },
    stack: [{ category: 'web_frontend', technologyId: 'astro' }],
    expectRoles: ['FRONTEND', 'UI_UX', 'QA'],
    /* No database in the stack, so nobody is writing backend code. */
    expectNoRoles: ['BACKEND', 'MOBILE', 'AI_ML'],
  },
  {
    name: 'a normal CRUD web application',
    projectTypes: ['WEB_APPLICATION'],
    timeline: { mode: 'WEEKS', weeks: 12 },
    source: {
      title: 'Internal tool brief',
      text: [
        'Staff must sign in and record their weekly timesheets.',
        'A manager must approve every timesheet before it is exported.',
        'The system must keep a history of every approval.',
      ].join('\n'),
    },
    stack: WEB_STACK,
    expectRoles: ['BACKEND', 'FRONTEND', 'QA', 'PM'],
    expectNoRoles: ['MOBILE'],
  },
  {
    name: 'an Android and iOS mobile app',
    projectTypes: ['ANDROID_APPLICATION', 'IOS_APPLICATION'],
    timeline: { mode: 'WEEKS', weeks: 16 },
    source: {
      title: 'Field app brief',
      text: [
        'Engineers must record job completions on their phones.',
        'A screen must display the day’s jobs.',
      ].join('\n'),
    },
    stack: [
      { category: 'native_android', technologyId: 'kotlin-android' },
      { category: 'native_ios', technologyId: 'swift-ios' },
      { category: 'backend', technologyId: 'nestjs' },
      { category: 'database', technologyId: 'postgresql' },
    ],
    expectRoles: ['MOBILE', 'BACKEND', 'QA'],
    expectNoRoles: ['FRONTEND'],
  },
  {
    name: 'a cross-platform mobile app',
    projectTypes: ['CROSS_PLATFORM_MOBILE'],
    timeline: { mode: 'WEEKS', weeks: 16 },
    source: {
      title: 'Field app brief',
      text: [
        'Engineers must record job completions on their phones.',
        'A screen must display the day’s jobs.',
      ].join('\n'),
    },
    stack: [
      { category: 'mobile_framework', technologyId: 'flutter' },
      { category: 'backend', technologyId: 'nestjs' },
      { category: 'database', technologyId: 'postgresql' },
    ],
    expectRoles: ['MOBILE', 'BACKEND'],
    expectNoRoles: ['FRONTEND'],
  },
  {
    name: 'an API-only service',
    projectTypes: ['BACKEND_API'],
    timeline: { mode: 'WEEKS', weeks: 8 },
    source: {
      title: 'Pricing service brief',
      text: [
        'The service must return a price for a given product and quantity.',
        'Prices must be stored and versioned so a quote can be reproduced.',
      ].join('\n'),
    },
    stack: [
      { category: 'backend', technologyId: 'nestjs' },
      { category: 'database', technologyId: 'postgresql' },
    ],
    expectRoles: ['BACKEND', 'QA', 'DEVOPS'],
    /* The one that matters most: an API service has no browser and no designer. */
    expectNoRoles: ['FRONTEND', 'UI_UX', 'MOBILE'],
  },
  {
    name: 'an AI application',
    projectTypes: ['AI_ML_SOLUTION'],
    timeline: { mode: 'WEEKS', weeks: 12 },
    source: {
      title: 'Classification brief',
      text: [
        'Incoming support emails must be classified into one of six categories.',
        'The classification must be recorded against the email.',
      ].join('\n'),
    },
    stack: [
      { category: 'ai_model', technologyId: 'open-weights-model' },
      { category: 'backend', technologyId: 'fastapi' },
      { category: 'database', technologyId: 'postgresql' },
    ],
    expectRoles: ['AI_ML', 'BACKEND', 'QA'],
    expectNoRoles: ['MOBILE'],
  },
  {
    name: 'an integration-heavy application',
    projectTypes: ['SYSTEM_INTEGRATION'],
    timeline: { mode: 'WEEKS', weeks: 12 },
    source: {
      title: 'Middleware brief',
      text: [
        'Orders must be sent to the third-party warehouse system within an hour.',
        'Failed transfers to the external system must be retried and reported.',
      ].join('\n'),
    },
    stack: [
      { category: 'integrations', technologyId: 'rest-api' },
      { category: 'backend', technologyId: 'nestjs' },
      { category: 'database', technologyId: 'postgresql' },
    ],
    expectRoles: ['BACKEND', 'QA', 'SOLUTION_ARCHITECT'],
    expectNoRoles: ['FRONTEND', 'MOBILE'],
  },
  {
    name: 'a multi-platform project',
    projectTypes: ['MULTI_PLATFORM_PRODUCT'],
    timeline: { mode: 'MONTHS', months: 6 },
    source: {
      title: 'Multi-platform brief',
      text: [
        'The product must be available in a browser and on phones.',
        'A page must display the shared data.',
      ].join('\n'),
    },
    stack: [
      { category: 'web_frontend', technologyId: 'react' },
      { category: 'mobile_framework', technologyId: 'react-native' },
      { category: 'backend', technologyId: 'nestjs' },
      { category: 'database', technologyId: 'postgresql' },
    ],
    expectRoles: ['FRONTEND', 'MOBILE', 'BACKEND'],
  },
  {
    name: 'an aggressive timeline',
    projectTypes: ['WEB_APPLICATION'],
    timeline: { mode: 'WEEKS', weeks: 1 },
    source: {
      title: 'Rush brief',
      text: [
        'Staff must sign in and record their weekly timesheets.',
        'A manager must approve every timesheet in a multi-step workflow.',
        'Orders must be sent to the third-party warehouse system.',
      ].join('\n'),
    },
    stack: WEB_STACK,
  },
  {
    name: 'a project with no team supplied',
    projectTypes: ['WEB_APPLICATION'],
    timeline: { mode: 'WEEKS', weeks: 8 },
    source: {
      title: 'No-team brief',
      text: ['Staff must sign in and record their weekly timesheets.'].join('\n'),
    },
    stack: WEB_STACK,
  },
  {
    name: 'a project with no start date',
    projectTypes: ['WEB_APPLICATION'],
    timeline: { mode: 'WEEKS', weeks: 8 },
    startDate: { mode: 'NOT_CONFIRMED' },
    source: {
      title: 'Undated brief',
      text: ['Staff must sign in and record their weekly timesheets.'].join('\n'),
    },
    stack: WEB_STACK,
  },
  {
    name: 'a project with a confirmed start date',
    projectTypes: ['WEB_APPLICATION'],
    timeline: { mode: 'WEEKS', weeks: 8 },
    startDate: { mode: 'CONFIRMED_DATE', date: '2026-09-07' },
    source: {
      title: 'Dated brief',
      text: ['Staff must sign in and record their weekly timesheets.'].join('\n'),
    },
    stack: WEB_STACK,
  },
  {
    name: 'a project with a fixed deadline',
    projectTypes: ['WEB_APPLICATION'],
    timeline: { mode: 'FIXED_DEADLINE', deadline: '2026-12-18' },
    startDate: { mode: 'CONFIRMED_DATE', date: '2026-09-07' },
    source: {
      title: 'Deadline brief',
      text: ['Staff must sign in and record their weekly timesheets.'].join('\n'),
    },
    stack: WEB_STACK,
  },
  {
    name: 'an enhancement to an existing system',
    projectTypes: ['APPLICATION_ENHANCEMENT'],
    timeline: { mode: 'WEEKS', weeks: 8 },
    source: {
      title: 'Enhancement brief',
      text: [
        'The existing timesheet screen must gain an export button.',
        'The export must include the approval history.',
      ].join('\n'),
    },
    stack: WEB_STACK,
  },
  {
    name: 'a migration project',
    projectTypes: ['MIGRATION'],
    timeline: { mode: 'MONTHS', months: 4 },
    source: {
      title: 'Migration brief',
      text: [
        'Existing customer data must be migrated from the legacy system.',
        'The migrated data must be reconciled against the source.',
      ].join('\n'),
    },
    stack: [
      { category: 'database', technologyId: 'postgresql' },
      { category: 'backend', technologyId: 'nestjs' },
      { category: 'data_processing', technologyId: 'etl-scripts' },
    ],
    expectRoles: ['DATA_ENGINEER', 'BACKEND'],
    expectNoRoles: ['MOBILE'],
  },
];

/**
 * A scripted assessment, for the test that exercises the AI path.
 *
 * Written out rather than generated, so a reader can see exactly what the model
 * "said" — and so the test that checks the application still does its own
 * arithmetic has something concrete to check it against.
 */
export function registerEstimationAssessment(
  provider: { register: (taskId: string, response: string) => void },
  requirementIds: readonly string[],
): void {
  provider.register(
    'estimation.assess',
    JSON.stringify({
      assessments: requirementIds.map((requirementId) => ({
        requirementId,
        taskCategory: 'business_logic',
        complexity: 'MEDIUM',
        complexityDrivers: ['workflow_depth', 'business_rules'],
        uncertaintySources: [],
        rationale: 'A multi-step approval with rules that vary — scripted for this test.',
      })),
    }),
  );
}
