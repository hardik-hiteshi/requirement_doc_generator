import { z } from 'zod';

import { COMPLEXITY_MULTIPLIERS, type ComplexityLevel } from './complexity.contract';

/**
 * What kind of engineer this estimate assumes, and how fast they work.
 *
 * Written down and versioned because it is the assumption every number in the
 * phase rests on, and an assumption nobody can find is one nobody can argue
 * with. `PRODUCTIVITY_MODEL_VERSION` is stored on every snapshot, so an estimate
 * produced today remains interpretable after the model changes.
 *
 * ## The team this assumes
 *
 * Experienced engineers, roughly three to four years in. Not seniors who have
 * built this exact system before, and not graduates. That is the band most
 * agency work is actually staffed at, and estimating against anything else
 * produces a number the delivery team cannot hit.
 *
 * ## AI-assisted, and what that does and does not mean
 *
 * The model assumes AI assistance is available and used. What it reduces is
 * **repetitive construction**: scaffolding, boilerplate, the fourth CRUD screen,
 * test skeletons, obvious refactors. What it does not reduce is everything that
 * makes software take time — understanding what the client meant, getting the
 * business rules right, integrating with something you do not control, finding
 * out why it is wrong, reviewing it, and shipping it.
 *
 * So the discount is applied **per task category, not globally**, and the
 * categories where it is largest are the ones where it is genuinely largest.
 * Debugging gets nothing. Integration gets almost nothing. Scaffolding gets a
 * lot.
 *
 * **A near-zero estimate is a defect, not a saving.** `MINIMUM_FEATURE_HOURS`
 * is a floor per estimate unit, because a feature that reaches a client's
 * proposal costing two hours is one nobody has thought about: it still needs
 * specifying, reviewing, testing and deploying, and those do not compress.
 *
 * ## What the client is told
 *
 * Nothing, unless the user says so. The methodology is recorded internally and
 * `mentionAiAssistance` on the snapshot defaults to false — a client-facing
 * document that volunteers "we used AI to write this faster" invites a
 * conversation about price that the user, not this application, should choose to
 * have.
 */

export const PRODUCTIVITY_MODEL_VERSION = 'v1';

export const PRODUCTIVITY_MODEL_SUMMARY =
  'Experienced engineers (approximately 3–4 years), working with AI assistance. The assistance reduces repetitive construction; it does not reduce understanding the problem, getting business rules right, integrating with systems we do not control, debugging, review, or release.';

/* ---------------------------------------------------------- task categories */

/**
 * The kind of work, which decides both the base hours and how much AI
 * assistance actually helps.
 */
export const TASK_CATEGORIES = [
  'scaffolding',
  'crud',
  'business_logic',
  'validation',
  'integration',
  'ui_implementation',
  'ui_design',
  'data_modelling',
  'migration',
  'ai_ml',
  'infrastructure',
  'testing',
  'analysis',
  'coordination',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export const taskCategorySchema = z.enum(TASK_CATEGORIES);

export const TASK_CATEGORY_LABELS: Readonly<Record<TaskCategory, string>> = {
  scaffolding: 'Scaffolding and setup',
  crud: 'Create, read, update, delete',
  business_logic: 'Business logic',
  validation: 'Validation and rules',
  integration: 'Integration',
  ui_implementation: 'Interface implementation',
  ui_design: 'Interface design',
  data_modelling: 'Data modelling',
  migration: 'Migration',
  ai_ml: 'AI / ML work',
  infrastructure: 'Infrastructure and deployment',
  testing: 'Testing',
  analysis: 'Analysis and specification',
  coordination: 'Coordination',
};

/**
 * Base hours for one unit of work at `LOW` complexity, before the complexity
 * multiplier and before the AI-assistance factor.
 *
 * These are the numbers a person can argue with, which is the point of having
 * them in one table rather than distributed through the code.
 */
export const BASE_HOURS: Readonly<Record<TaskCategory, number>> = {
  scaffolding: 6,
  crud: 8,
  business_logic: 12,
  validation: 5,
  integration: 16,
  ui_implementation: 10,
  ui_design: 8,
  data_modelling: 8,
  migration: 16,
  ai_ml: 20,
  infrastructure: 10,
  testing: 8,
  analysis: 6,
  coordination: 4,
};

/**
 * How much AI assistance actually helps, per category. 1.0 means no help.
 *
 * The shape of this table *is* the argument. Scaffolding compresses hard
 * because it is pattern-following. Integration barely moves because the
 * difficulty is in the other system's behaviour. Analysis and coordination do
 * not move at all, because they are conversations with people.
 */
export const AI_ASSISTANCE_FACTORS: Readonly<Record<TaskCategory, number>> = {
  scaffolding: 0.45,
  crud: 0.55,
  business_logic: 0.85,
  validation: 0.7,
  integration: 0.9,
  ui_implementation: 0.7,
  ui_design: 0.95,
  data_modelling: 0.8,
  migration: 0.9,
  ai_ml: 0.85,
  infrastructure: 0.75,
  testing: 0.7,
  analysis: 1,
  coordination: 1,
};

/**
 * The floor for any single estimate unit, in hours.
 *
 * A feature costed below this has not been thought about. Even a trivial one
 * needs a conversation, a change, a review, a test and a deployment — and those
 * do not compress however good the tooling is.
 */
export const MINIMUM_FEATURE_HOURS = 2;

/** Nothing may exceed this in one unit; beyond it, the unit needs splitting. */
export const MAXIMUM_FEATURE_HOURS = 400;

export interface BaseEffortInput {
  readonly category: TaskCategory;
  readonly complexity: ComplexityLevel;
  /** How many of this thing. Three similar screens rather than one. */
  readonly quantity?: number;
}

/**
 * Deterministic base effort for one unit of work.
 *
 * The boundary the whole hybrid model rests on: the model may propose a
 * category, a complexity and a quantity, and this decides what those are worth.
 * A model proposing an hours figure directly would be proposing the answer.
 */
export function baseEffortHours(input: BaseEffortInput): number {
  const quantity = Math.max(1, input.quantity ?? 1);
  const raw =
    BASE_HOURS[input.category] *
    COMPLEXITY_MULTIPLIERS[input.complexity] *
    AI_ASSISTANCE_FACTORS[input.category] *
    quantity;

  return Number(Math.max(MINIMUM_FEATURE_HOURS, Math.min(MAXIMUM_FEATURE_HOURS, raw)).toFixed(2));
}

/**
 * Whether an hours figure is one this application is willing to store.
 *
 * Applied to every value, including the user's own overrides — not to overrule
 * them, but because a negative or infinite number is a typo rather than a
 * decision, and storing it would corrupt every total above it.
 */
export function isPlausibleHours(hours: number): boolean {
  return Number.isFinite(hours) && hours >= 0 && hours <= MAXIMUM_FEATURE_HOURS * 10;
}

/* --------------------------------------------------------------- overhead */

/**
 * Work that is real, is not a feature, and is not padding.
 *
 * Named explicitly rather than folded into a percentage on top of everything,
 * because "we added 30%" is not something a client can evaluate and not
 * something a delivery team can plan against. Each of these is an activity
 * somebody does.
 */
export const OVERHEAD_ACTIVITIES = [
  'environment_setup',
  'shared_architecture',
  'ci_cd',
  'deployment_preparation',
  'code_review',
  'release_stabilisation',
  'project_coordination',
  'qa_regression',
  'uat_support',
] as const;

export type OverheadActivity = (typeof OVERHEAD_ACTIVITIES)[number];
export const overheadActivitySchema = z.enum(OVERHEAD_ACTIVITIES);

export const OVERHEAD_LABELS: Readonly<Record<OverheadActivity, string>> = {
  environment_setup: 'Setting up environments',
  shared_architecture: 'Shared architecture and foundations',
  ci_cd: 'Build and deployment pipeline',
  deployment_preparation: 'Preparing for deployment',
  code_review: 'Code review',
  release_stabilisation: 'Stabilising the release',
  project_coordination: 'Coordination and reporting',
  qa_regression: 'Regression testing',
  uat_support: 'Supporting user acceptance testing',
};

export const OVERHEAD_DESCRIPTIONS: Readonly<Record<OverheadActivity, string>> = {
  environment_setup: 'Development, staging and production environments, and the access to them.',
  shared_architecture:
    'The parts every feature sits on: project structure, shared modules, conventions.',
  ci_cd: 'Automated build, test and deploy.',
  deployment_preparation: 'Release notes, configuration, runbooks, cutover planning.',
  code_review: 'Reading each other’s work before it ships. Proportional to what is written.',
  release_stabilisation: 'The gap between "feature complete" and "we would ship this".',
  project_coordination: 'Standups, planning, status, the questions that unblock people.',
  qa_regression: 'Re-testing what already worked, after each change to something near it.',
  uat_support: 'Being available while the client tests, and fixing what they find.',
};

/**
 * Which overheads apply, and what they are worth.
 *
 * Two shapes. Some are **proportional** — code review and regression scale with
 * how much was built. Some are **fixed** — setting up environments costs what it
 * costs whether the project is small or large, which is why small projects feel
 * disproportionately expensive and why hiding it inside a percentage misleads.
 */
export interface OverheadRule {
  readonly activity: OverheadActivity;
  /** Fraction of implementation effort, for proportional overheads. */
  readonly proportion?: number;
  /** Flat hours, for fixed overheads. */
  readonly fixedHours?: number;
  readonly role: string;
}

export const OVERHEAD_RULES: readonly OverheadRule[] = [
  { activity: 'environment_setup', fixedHours: 12, role: 'DEVOPS' },
  { activity: 'shared_architecture', proportion: 0.08, role: 'SOLUTION_ARCHITECT' },
  { activity: 'ci_cd', fixedHours: 10, role: 'DEVOPS' },
  { activity: 'deployment_preparation', fixedHours: 8, role: 'DEVOPS' },
  { activity: 'code_review', proportion: 0.1, role: 'BACKEND' },
  { activity: 'release_stabilisation', proportion: 0.06, role: 'QA' },
  { activity: 'project_coordination', proportion: 0.09, role: 'PM' },
  { activity: 'qa_regression', proportion: 0.12, role: 'QA' },
  { activity: 'uat_support', proportion: 0.05, role: 'QA' },
];
