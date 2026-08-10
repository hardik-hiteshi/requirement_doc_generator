import { z } from 'zod';

/**
 * How hard a feature is, and why.
 *
 * The number that drives everything downstream, so the thing that matters most
 * about it is not accuracy — no estimate is accurate — but **explainability**.
 * A reviewer looking at "HIGH" has to be able to see what made it high and
 * disagree with a specific line, rather than with a verdict.
 *
 * Hence the shape: complexity is not a value the model returns. It is a set of
 * *drivers*, each of which is a claim about the requirement, and the level is
 * derived from them by `deriveComplexity`. The model may propose drivers; the
 * application decides what they add up to.
 *
 * **Never from text length.** A one-line requirement can describe a payment
 * reconciliation; a paragraph can describe a footer. Length is not a driver and
 * is not consulted anywhere in this file.
 */

export const COMPLEXITY_LEVELS = ['TRIVIAL', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'] as const;

export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];
export const complexityLevelSchema = z.enum(COMPLEXITY_LEVELS);

export const COMPLEXITY_LABELS: Readonly<Record<ComplexityLevel, string>> = {
  TRIVIAL: 'Trivial',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  VERY_HIGH: 'Very high',
};

export const COMPLEXITY_RANK: Readonly<Record<ComplexityLevel, number>> = Object.fromEntries(
  COMPLEXITY_LEVELS.map((level, index) => [level, index]),
) as Record<ComplexityLevel, number>;

/**
 * The things that make work hard.
 *
 * Each is a property of the requirement or of the locked stack, not an opinion
 * about the requirement. "This needs a multi-step approval workflow" is
 * checkable; "this feels complicated" is not.
 */
export const COMPLEXITY_DRIVERS = [
  'workflow_depth',
  'business_rules',
  'validation_complexity',
  'data_complexity',
  'integration_complexity',
  'security_requirements',
  'realtime_behaviour',
  'offline_behaviour',
  'platform_count',
  'custom_ui',
  'external_api_uncertainty',
  'migration_effort',
  'ai_ml_complexity',
  'deployment_complexity',
] as const;

export type ComplexityDriver = (typeof COMPLEXITY_DRIVERS)[number];
export const complexityDriverSchema = z.enum(COMPLEXITY_DRIVERS);

export const COMPLEXITY_DRIVER_LABELS: Readonly<Record<ComplexityDriver, string>> = {
  workflow_depth: 'A multi-step workflow',
  business_rules: 'Several business rules',
  validation_complexity: 'Non-trivial validation',
  data_complexity: 'A complicated data model',
  integration_complexity: 'Talking to a system we do not own',
  security_requirements: 'Explicit security requirements',
  realtime_behaviour: 'Real-time behaviour',
  offline_behaviour: 'Working offline and syncing',
  platform_count: 'More than one platform to build for',
  custom_ui: 'Custom interface work',
  external_api_uncertainty: 'An external API nobody has used yet',
  migration_effort: 'Moving existing data or users',
  ai_ml_complexity: 'Model behaviour to get right',
  deployment_complexity: 'Non-standard deployment',
};

/**
 * What each driver is worth.
 *
 * Coarse and deliberately so. The weights exist to put features in the right
 * *band*, not to express a belief that a workflow is precisely 1.4 times a
 * validation rule. Two drivers are worth more than the rest because they are
 * the two that most reliably blow an estimate: something we do not control, and
 * something nobody has built before.
 */
export const DRIVER_WEIGHTS: Readonly<Record<ComplexityDriver, number>> = {
  workflow_depth: 1,
  business_rules: 1,
  validation_complexity: 0.5,
  data_complexity: 1,
  integration_complexity: 1.5,
  security_requirements: 1,
  realtime_behaviour: 1.5,
  offline_behaviour: 1.5,
  platform_count: 1,
  custom_ui: 1,
  external_api_uncertainty: 1.5,
  migration_effort: 1.5,
  ai_ml_complexity: 1.5,
  deployment_complexity: 0.5,
};

export interface ComplexityAssessment {
  readonly level: ComplexityLevel;
  readonly drivers: readonly ComplexityDriver[];
  readonly score: number;
  /** Plain language, built from the drivers so the two cannot disagree. */
  readonly explanation: string;
}

/**
 * Complexity from drivers, deterministically.
 *
 * A feature with nothing notable about it is `TRIVIAL` — and that is a real
 * answer, not a failure to assess. Most CRUD screens are trivial, and inflating
 * them is how an estimate becomes a number nobody believes.
 */
export function deriveComplexity(drivers: readonly ComplexityDriver[]): ComplexityAssessment {
  const unique = [...new Set(drivers)];
  const score = Number(
    unique.reduce((total, driver) => total + DRIVER_WEIGHTS[driver], 0).toFixed(2),
  );

  const level: ComplexityLevel =
    score === 0
      ? 'TRIVIAL'
      : score <= 1.5
        ? 'LOW'
        : score <= 3
          ? 'MEDIUM'
          : score <= 5
            ? 'HIGH'
            : 'VERY_HIGH';

  return { level, drivers: unique, score, explanation: explain(level, unique) };
}

function explain(level: ComplexityLevel, drivers: readonly ComplexityDriver[]): string {
  if (drivers.length === 0) {
    return 'Nothing about this is unusual — it is ordinary work.';
  }

  const reasons = drivers.map((driver) => COMPLEXITY_DRIVER_LABELS[driver].toLowerCase());

  return `${COMPLEXITY_LABELS[level]}: ${reasons.join('; ')}.`;
}

/**
 * The multiplier a complexity level applies to base effort.
 *
 * Applied to a base derived from the task category, so a trivial CRUD screen
 * and a very complex one differ by roughly six times rather than by an
 * arbitrary padding percentage.
 */
export const COMPLEXITY_MULTIPLIERS: Readonly<Record<ComplexityLevel, number>> = {
  TRIVIAL: 0.6,
  LOW: 1,
  MEDIUM: 1.8,
  HIGH: 3,
  VERY_HIGH: 4.5,
};

/* ------------------------------------------------------------ uncertainty */

/**
 * How sure we are, and why.
 *
 * Separate from complexity, because they are different claims. A feature can be
 * complex and well understood — a payment flow against a documented API — or
 * simple and completely unknown, like a one-line integration with a system
 * nobody has seen. The second is what wrecks a plan.
 */
export const UNCERTAINTY_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;

export type UncertaintyLevel = (typeof UNCERTAINTY_LEVELS)[number];
export const uncertaintyLevelSchema = z.enum(UNCERTAINTY_LEVELS);

export const UNCERTAINTY_LABELS: Readonly<Record<UncertaintyLevel, string>> = {
  LOW: 'Well understood',
  MEDIUM: 'Some unknowns',
  HIGH: 'Substantially unknown',
};

/** Why we are unsure. Each is a fact about what we do or do not have. */
export const UNCERTAINTY_SOURCES = [
  'external_api_undocumented',
  'no_sandbox_available',
  'codebase_not_assessed',
  'requirement_ambiguous',
  'scale_unknown',
  'third_party_dependency',
  'new_technology_to_team',
  'client_process_unknown',
] as const;

export type UncertaintySource = (typeof UNCERTAINTY_SOURCES)[number];
export const uncertaintySourceSchema = z.enum(UNCERTAINTY_SOURCES);

export const UNCERTAINTY_SOURCE_LABELS: Readonly<Record<UncertaintySource, string>> = {
  external_api_undocumented: 'The external API has no documentation we have seen',
  no_sandbox_available: 'There is no sandbox to test against',
  codebase_not_assessed: 'Nobody has looked at the existing codebase',
  requirement_ambiguous: 'The requirement leaves room for interpretation',
  scale_unknown: 'Nobody has told us the expected volumes',
  third_party_dependency: 'It depends on somebody outside the team',
  new_technology_to_team: 'The team has not used this technology before',
  client_process_unknown: 'The client’s own process is not documented',
};

/**
 * Uncertainty from its sources.
 *
 * Two or more independent unknowns is `HIGH`, because they compound: an
 * undocumented API *and* no sandbox is not twice as risky as either, it is a
 * feature nobody can size.
 */
export function deriveUncertainty(sources: readonly UncertaintySource[]): {
  readonly level: UncertaintyLevel;
  readonly sources: readonly UncertaintySource[];
  readonly explanation: string;
} {
  const unique = [...new Set(sources)];
  const level: UncertaintyLevel =
    unique.length === 0 ? 'LOW' : unique.length === 1 ? 'MEDIUM' : 'HIGH';

  return {
    level,
    sources: unique,
    explanation:
      unique.length === 0
        ? 'Nothing about this is unknown.'
        : unique.map((source) => UNCERTAINTY_SOURCE_LABELS[source]).join('; ') + '.',
  };
}
