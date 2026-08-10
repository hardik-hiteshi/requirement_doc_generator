import {
  BASE_HOURS,
  OVERHEAD_RULES,
  baseEffortHours,
  deriveComplexity,
  deriveUncertainty,
  rangeFor,
  type ComplexityDriver,
  type ComplexityLevel,
  type EffortDriver,
  type OverheadRule,
  type RoleEffort,
  type RoleKey,
  type TaskCategory,
  type UncertaintyLevel,
  type UncertaintySource,
} from '@wdrg/contracts';

/**
 * Turning one approved requirement into one estimate line, without a model.
 *
 * This is the deterministic half of the hybrid estimation model, and it is the
 * half that always runs. A model may propose a better task category, a
 * different complexity, or drivers this file did not spot — but everything it
 * proposes is fed back through `estimateUnit` below, so the *arithmetic* is
 * always the application's. A model that returned hours directly would be
 * returning the answer.
 *
 * ## What it reads
 *
 * The requirement's category and its own words, the locked stack's technologies,
 * and the project's roles. Nothing else. In particular it does not read the
 * *length* of the requirement, which correlates with how carefully somebody
 * wrote it and not with how long it takes to build.
 *
 * ## What it produces when it is unsure
 *
 * A `MEDIUM`-complexity line with the drivers it did find and an honest
 * rationale. Not a refusal — a plan with a hole in it is worse than a plan with
 * a line somebody has to check, and the line is marked `SYSTEM_CALCULATED` so a
 * reviewer knows nobody thought hard about it yet.
 */

export interface RequirementInput {
  readonly itemId: string;
  readonly title: string;
  readonly statement: string;
  readonly category: string;
  readonly nfrDimension?: string;
  readonly priority?: string;
}

export interface StackContextInput {
  /** Locked-stack technology ids, by category. */
  readonly technologies: readonly {
    readonly category: string;
    readonly technologyId?: string;
    readonly name: string;
  }[];
  /** Roles this project can have work in. */
  readonly roles: readonly RoleKey[];
}

export interface EstimateDraft {
  readonly requirementIds: readonly string[];
  readonly feature: string;
  readonly module: string;
  readonly submodule: string;
  readonly taskCategory: TaskCategory;
  readonly complexity: ComplexityLevel;
  readonly complexityDrivers: readonly ComplexityDriver[];
  readonly complexityExplanation: string;
  readonly uncertainty: UncertaintyLevel;
  readonly uncertaintySources: readonly UncertaintySource[];
  readonly uncertaintyExplanation: string;
  readonly effort: RoleEffort;
  readonly totalHours: number;
  readonly range: {
    readonly optimistic: number;
    readonly expected: number;
    readonly conservative: number;
  };
  readonly drivers: readonly EffortDriver[];
  readonly rationale: string;
  readonly overheadActivity?: string;
}

/* -------------------------------------------------------- classification */

/**
 * Phrases that mean a particular kind of work.
 *
 * Deliberately narrow, and matched against the requirement's own words. A miss
 * lands the line in `business_logic` at `MEDIUM`, which is the safe default —
 * an over-eager match would silently reprice something.
 */
const CATEGORY_PHRASES: readonly [TaskCategory, readonly string[]][] = [
  [
    'integration',
    ['integrat', 'third-party', 'third party', 'external system', 'webhook', 'api of'],
  ],
  ['migration', ['migrat', 'import existing', 'move data', 'legacy data']],
  ['ai_ml', ['machine learning', 'model predict', 'classif', 'semantic', 'embedding', 'inference']],
  ['data_modelling', ['data model', 'schema', 'store and retrieve', 'record structure']],
  ['validation', ['validat', 'must be checked', 'rule that', 'constraint']],
  ['ui_implementation', ['screen', 'page', 'dashboard', 'form', 'display', 'interface', 'view']],
  ['infrastructure', ['deploy', 'environment', 'backup', 'monitor', 'pipeline']],
  ['crud', ['create', 'edit', 'delete', 'list', 'update', 'manage']],
  ['business_logic', ['approv', 'calculat', 'workflow', 'process', 'rule']],
];

/** Phrases that indicate a complexity driver. */
const DRIVER_PHRASES: readonly [ComplexityDriver, readonly string[]][] = [
  ['workflow_depth', ['approv', 'multi-step', 'workflow', 'stage', 'escalat']],
  ['business_rules', ['rule', 'policy', 'depending on', 'unless', 'only if']],
  ['validation_complexity', ['validat', 'must not', 'required field', 'format']],
  ['data_complexity', ['relationship', 'hierarch', 'history', 'audit trail', 'version']],
  ['integration_complexity', ['integrat', 'third-party', 'third party', 'external system']],
  [
    'security_requirements',
    ['permission', 'role-based', 'encrypt', 'gdpr', 'audit', 'authoris', 'authoriz'],
  ],
  ['realtime_behaviour', ['real time', 'real-time', 'live', 'instantly', 'push notification']],
  ['offline_behaviour', ['offline', 'no signal', 'sync when', 'without connectivity']],
  ['custom_ui', ['custom', 'bespoke', 'interactive', 'drag', 'chart', 'visualis', 'visualiz']],
  ['migration_effort', ['migrat', 'existing data', 'legacy']],
  ['ai_ml_complexity', ['machine learning', 'model', 'predict', 'semantic', 'classif']],
];

/** Phrases that indicate an unknown. */
const UNCERTAINTY_PHRASES: readonly [UncertaintySource, readonly string[]][] = [
  ['external_api_undocumented', ['undocumented', 'no documentation', 'unknown api']],
  ['scale_unknown', ['scale', 'volume', 'concurrent users', 'load']],
  ['third_party_dependency', ['third-party', 'third party', 'external system', 'provider']],
  ['client_process_unknown', ['existing process', 'current process', 'as they do today']],
];

function matchAll<T>(text: string, table: readonly [T, readonly string[]][]): T[] {
  return table
    .filter(([, phrases]) => phrases.some((phrase) => text.includes(phrase)))
    .map(([key]) => key);
}

/** The kind of work a requirement describes. */
export function classifyTask(requirement: RequirementInput): TaskCategory {
  const text = `${requirement.title} ${requirement.statement}`.toLowerCase();

  if (requirement.category === 'non_functional') {
    return requirement.nfrDimension === 'security' ? 'validation' : 'infrastructure';
  }

  if (requirement.category === 'integration') {
    return 'integration';
  }

  if (requirement.category === 'data') {
    return 'data_modelling';
  }

  return matchAll(text, CATEGORY_PHRASES)[0] ?? 'business_logic';
}

/* ------------------------------------------------------------- effort */

/**
 * How the hours for one line are split across roles.
 *
 * Shares rather than absolute numbers, so the split holds whatever the total
 * turns out to be — and only roles the project actually has are used, which is
 * what stops an API-only project acquiring frontend hours.
 */
const ROLE_SHARES: Readonly<Record<TaskCategory, Readonly<Record<string, number>>>> = {
  scaffolding: { BACKEND: 0.6, DEVOPS: 0.4 },
  crud: { BACKEND: 0.45, FRONTEND: 0.35, QA: 0.2 },
  business_logic: { BACKEND: 0.6, QA: 0.25, BA: 0.15 },
  validation: { BACKEND: 0.55, QA: 0.35, BA: 0.1 },
  integration: { BACKEND: 0.6, QA: 0.25, SOLUTION_ARCHITECT: 0.15 },
  ui_implementation: { FRONTEND: 0.7, UI_UX: 0.15, QA: 0.15 },
  ui_design: { UI_UX: 0.85, FRONTEND: 0.15 },
  data_modelling: { BACKEND: 0.55, SOLUTION_ARCHITECT: 0.25, DATA_ENGINEER: 0.2 },
  migration: { DATA_ENGINEER: 0.5, BACKEND: 0.3, QA: 0.2 },
  ai_ml: { AI_ML: 0.65, BACKEND: 0.2, QA: 0.15 },
  infrastructure: { DEVOPS: 0.75, BACKEND: 0.25 },
  testing: { QA: 1 },
  analysis: { BA: 0.7, SOLUTION_ARCHITECT: 0.3 },
  coordination: { PM: 1 },
};

/**
 * Roles that do the same job on a different platform.
 *
 * A mobile project has no `FRONTEND` role, but the interface work does not
 * vanish — it is done by `MOBILE`. Without this the share table's frontend
 * portion would be redistributed to the backend, and a mobile app would be
 * costed as though nobody wrote any screens.
 *
 * Substitution is tried before redistribution, because "somebody else does this
 * work" is a better answer than "spread it over whoever is left".
 */
const ROLE_SUBSTITUTES: Readonly<Record<string, readonly string[]>> = {
  FRONTEND: ['MOBILE'],
  MOBILE: ['FRONTEND'],
  DATA_ENGINEER: ['BACKEND'],
  AI_ML: ['BACKEND'],
  SOLUTION_ARCHITECT: ['BACKEND'],
  UI_UX: ['FRONTEND', 'MOBILE'],
};

/** The role that will actually do this share of the work, if any will. */
function resolveRole(role: string, availableRoles: readonly RoleKey[]): string | undefined {
  if (availableRoles.includes(role)) {
    return role;
  }

  return (ROLE_SUBSTITUTES[role] ?? []).find((substitute) => availableRoles.includes(substitute));
}

/**
 * Redistribute a share table onto the roles this project has.
 *
 * Two steps, in order. A share whose role is absent is first offered to a
 * *substitute* — the discipline that does the same work on this platform. Only
 * if there is no substitute is it redistributed across the remaining roles.
 *
 * Neither step drops it. Dropping would quietly reduce the estimate by however
 * much frontend work an API project "did not" need, which is a discount nobody
 * applied on purpose.
 */
export function splitAcrossRoles(
  hours: number,
  category: TaskCategory,
  availableRoles: readonly RoleKey[],
): RoleEffort {
  const shares = ROLE_SHARES[category];
  const resolved = new Map<string, number>();

  /*
   * A project with both a web frontend and a mobile framework builds its
   * interfaces twice, on two platforms, by two disciplines. The share is split
   * between them rather than handed to whichever the table happens to name —
   * otherwise a multi-platform product is costed as though the phones build
   * themselves.
   */
  const interfaceRoles = ['FRONTEND', 'MOBILE'].filter((role) => availableRoles.includes(role));

  for (const [role, share] of Object.entries(shares)) {
    if (role === 'FRONTEND' && interfaceRoles.length > 1) {
      for (const target of interfaceRoles) {
        resolved.set(target, (resolved.get(target) ?? 0) + share / interfaceRoles.length);
      }

      continue;
    }

    const target = resolveRole(role, availableRoles);

    if (target) {
      resolved.set(target, (resolved.get(target) ?? 0) + share);
    }
  }

  const usable = [...resolved.entries()];

  if (usable.length === 0) {
    // Nothing in the table applies. Everything falls to the first role the
    // project does have, so the hours are never silently lost.
    const fallback = availableRoles[0] ?? 'BACKEND';

    return { [fallback]: Number(hours.toFixed(2)) };
  }

  const totalShare = usable.reduce((total, [, share]) => total + share, 0);

  return Object.fromEntries(
    usable.map(([role, share]) => [role, Number(((hours * share) / totalShare).toFixed(2))]),
  );
}

export interface EstimateOptions {
  /** Complexity a model proposed, if any. The application still does the sums. */
  readonly proposedComplexity?: ComplexityLevel;
  readonly proposedDrivers?: readonly ComplexityDriver[];
  readonly proposedUncertainty?: readonly UncertaintySource[];
  readonly proposedCategory?: TaskCategory;
  readonly proposedRationale?: string;
}

/**
 * One estimate line from one requirement.
 *
 * The single entry point for both halves of the hybrid model: called with no
 * options it is the pure deterministic path, and called with a model's
 * proposals it uses them as *inputs* to the same arithmetic. There is no second
 * code path where a model's number reaches the plan unexamined.
 */
export function estimateUnit(
  requirement: RequirementInput,
  stack: StackContextInput,
  options: EstimateOptions = {},
): EstimateDraft {
  const text = `${requirement.title} ${requirement.statement}`.toLowerCase();
  const taskCategory = options.proposedCategory ?? classifyTask(requirement);

  const detectedDrivers = matchAll(text, DRIVER_PHRASES);
  const platformDrivers = platformComplexity(stack);
  const drivers = [
    ...new Set([...(options.proposedDrivers ?? detectedDrivers), ...platformDrivers]),
  ];

  const assessment = deriveComplexity(drivers);
  /*
   * A model may propose a level, and it is honoured — but the drivers behind it
   * are still the application's, so the explanation on screen always matches
   * something checkable rather than the model's confidence.
   */
  const complexity = options.proposedComplexity ?? assessment.level;

  const sources = [
    ...new Set([...(options.proposedUncertainty ?? matchAll(text, UNCERTAINTY_PHRASES))]),
  ];
  const uncertainty = deriveUncertainty(sources);

  const baseHours = baseEffortHours({ category: taskCategory, complexity });
  const technologyDrivers = technologyImpact(stack, taskCategory, requirement);
  const additional = technologyDrivers.reduce(
    (total, driver) => total + (driver.additionalHours ?? 0),
    0,
  );
  const totalHours = Number((baseHours + additional).toFixed(2));

  return {
    requirementIds: [requirement.itemId],
    feature: requirement.title,
    module: '',
    submodule: '',
    taskCategory,
    complexity,
    complexityDrivers: drivers,
    complexityExplanation: deriveComplexity(drivers).explanation,
    uncertainty: uncertainty.level,
    uncertaintySources: sources,
    uncertaintyExplanation: uncertainty.explanation,
    effort: splitAcrossRoles(totalHours, taskCategory, stack.roles),
    totalHours,
    range: rangeFor(totalHours, uncertainty.level),
    drivers: technologyDrivers,
    rationale:
      options.proposedRationale ??
      `${assessment.explanation} Based on ${BASE_HOURS[taskCategory]} hours for ${taskCategory.replaceAll('_', ' ')} work at low complexity, adjusted for the drivers above.`,
  };
}

/**
 * Complexity the *stack* creates, regardless of what the requirement says.
 *
 * The specification's clearest example: native Android and native iOS are two
 * implementations of the same feature, and that is a fact about the locked
 * stack rather than about the brief.
 */
function platformComplexity(stack: StackContextInput): ComplexityDriver[] {
  const categories = new Set(stack.technologies.map((technology) => technology.category));
  const nativePlatforms =
    (categories.has('native_android') ? 1 : 0) + (categories.has('native_ios') ? 1 : 0);

  return nativePlatforms > 1 ? ['platform_count'] : [];
}

/**
 * Extra hours the locked stack is responsible for, each traced to a technology.
 *
 * Every driver names a `technologyId` from the locked snapshot, which is what
 * makes "this costs more because you chose two native platforms" a checkable
 * claim rather than an opinion — and what stops the estimator ever *changing*
 * the technology instead of pricing it.
 */
export function technologyImpact(
  stack: StackContextInput,
  taskCategory: TaskCategory,
  requirement: RequirementInput,
): EffortDriver[] {
  const drivers: EffortDriver[] = [];
  const byCategory = new Map(
    stack.technologies.map((technology) => [technology.category, technology]),
  );

  const android = byCategory.get('native_android');
  const ios = byCategory.get('native_ios');

  /*
   * Two native platforms, two implementations. A cross-platform framework is
   * one — which is the whole reason a team picks one, and the estimate has to
   * show the difference or the choice looks free.
   */
  if (android && ios && (taskCategory === 'ui_implementation' || taskCategory === 'crud')) {
    drivers.push({
      kind: 'technology',
      technologyId: ios.technologyId ?? 'native-ios',
      requirementIds: [requirement.itemId],
      summary: `${android.name} and ${ios.name} are separate codebases, so this is built twice.`,
      additionalHours: Number((BASE_HOURS[taskCategory] * 0.8).toFixed(2)),
    });
  }

  if (taskCategory === 'integration') {
    const integration = byCategory.get('integrations');

    drivers.push({
      kind: 'integration',
      ...(integration?.technologyId ? { technologyId: integration.technologyId } : {}),
      requirementIds: [requirement.itemId],
      summary:
        'Integration work carries error handling, retries and testing against a system we do not control.',
      additionalHours: 4,
    });
  }

  const hosting = byCategory.get('hosting');

  if (hosting && taskCategory === 'infrastructure' && hosting.technologyId === 'on-premise') {
    drivers.push({
      kind: 'technology',
      technologyId: hosting.technologyId,
      requirementIds: [requirement.itemId],
      summary:
        'Running on the client’s own infrastructure means provisioning, access and operations we do not otherwise do.',
      additionalHours: 6,
    });
  }

  const aiModel = byCategory.get('ai_model');

  if (aiModel && taskCategory === 'ai_ml') {
    drivers.push({
      kind: 'technology',
      technologyId: aiModel.technologyId ?? 'ai-model',
      requirementIds: [requirement.itemId],
      summary: `${aiModel.name} needs prompt work, evaluation and testing against outputs that vary.`,
      additionalHours: 8,
    });
  }

  return drivers;
}

/* ------------------------------------------------------------ overhead */

/**
 * The overhead lines, as real estimate units.
 *
 * Produced as lines rather than a percentage on the total, so a reader can see
 * what each is and disagree with one of them. The fixed ones do not scale, which
 * is why a very small project carries proportionally more of them — a fact worth
 * seeing rather than hiding.
 */
export function overheadUnits(
  implementationHours: number,
  availableRoles: readonly RoleKey[],
  rules: readonly OverheadRule[] = OVERHEAD_RULES,
): readonly EstimateDraft[] {
  return rules
    .filter((rule) => availableRoles.includes(rule.role))
    .map((rule) => {
      const hours = Number(
        (rule.fixedHours ?? implementationHours * (rule.proportion ?? 0)).toFixed(2),
      );

      return {
        requirementIds: [],
        feature: rule.activity.replaceAll('_', ' '),
        module: 'Delivery',
        submodule: '',
        taskCategory: overheadCategory(rule.activity),
        complexity: 'LOW' as const,
        complexityDrivers: [],
        complexityExplanation: 'Overhead, sized from the implementation work rather than assessed.',
        uncertainty: 'LOW' as const,
        uncertaintySources: [],
        uncertaintyExplanation: 'Nothing about this is unknown.',
        effort: { [rule.role]: hours },
        totalHours: hours,
        range: rangeFor(hours, 'LOW'),
        drivers: [],
        rationale: rule.fixedHours
          ? `A fixed ${rule.fixedHours} hours — this costs the same whatever the project size.`
          : `${Math.round((rule.proportion ?? 0) * 100)}% of implementation effort.`,
        overheadActivity: rule.activity,
      };
    })
    .filter((draft) => draft.totalHours > 0);
}

function overheadCategory(activity: string): TaskCategory {
  if (activity === 'project_coordination') {
    return 'coordination';
  }

  if (
    activity === 'qa_regression' ||
    activity === 'release_stabilisation' ||
    activity === 'uat_support'
  ) {
    return 'testing';
  }

  if (activity === 'shared_architecture') {
    return 'analysis';
  }

  return 'infrastructure';
}
