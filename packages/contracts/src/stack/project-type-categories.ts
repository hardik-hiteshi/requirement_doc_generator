import type { ProjectType } from '../project/project-type.contract';
import {
  TECHNOLOGY_CATEGORIES,
  requiresJustification,
  type CategoryApplicability,
  type CategoryApplicabilityEntry,
  type TechnologyCategory,
} from './technology-category.contract';

/**
 * Which technology categories a project actually has.
 *
 * The thing that stops a stack being a checklist. A static website has no
 * database, an API service has no frontend, an Android app has no iOS
 * framework — and a tool that asks for all of them produces a stack full of
 * technologies nobody chose and an estimate that prices them.
 *
 * Three levels of answer, and the distinction between the last two is where the
 * discipline lives:
 *
 * - **required** — the project cannot be built without something here.
 * - **optional** — reasonable to have, fine to approve without.
 * - **conditional** — only if a requirement asks. `cache`, `search`,
 *   `message_queue`, `vector_storage`, `api_gateway`, `realtime`,
 *   `containerization` and `data_processing` all live here for every project
 *   type. Nothing puts Redis or Kafka in a stack because the project is "large";
 *   something in the approved baseline has to ask for it, and the requirement id
 *   is recorded next to it.
 *
 * Anything not named for a project type is `not_applicable` and is not shown,
 * not recommended and not counted as missing.
 */

interface CategoryPlan {
  readonly required: readonly TechnologyCategory[];
  readonly optional: readonly TechnologyCategory[];
}

/** Categories every project can reasonably have, whatever it is. */
const UNIVERSAL_OPTIONAL: readonly TechnologyCategory[] = [
  'hosting',
  'ci_cd',
  'monitoring',
  'logging',
  'testing',
  'security_tooling',
  'analytics',
  'integrations',
  'other',
];

const PLANS: Readonly<Record<ProjectType, CategoryPlan>> = {
  /*
   * A website is content and presentation. The database is optional rather
   * than required precisely because "static site, no backend" is a real and
   * frequently correct answer — and the moment a database is *required*, a
   * backend follows, and an estimate has grown a server nobody asked for.
   */
  WEBSITE: {
    required: ['web_frontend'],
    optional: ['content_management', 'backend', 'database', 'object_storage'],
  },
  WEB_APPLICATION: {
    required: ['web_frontend', 'backend', 'database'],
    optional: ['authentication', 'authorization', 'object_storage', 'background_jobs'],
  },
  SAAS_PLATFORM: {
    required: ['web_frontend', 'backend', 'database', 'authentication'],
    optional: ['authorization', 'object_storage', 'background_jobs', 'payment'],
  },
  ADMIN_PORTAL: {
    required: ['web_frontend', 'backend'],
    optional: ['database', 'authentication', 'authorization'],
  },
  ECOMMERCE_PLATFORM: {
    required: ['web_frontend', 'backend', 'database', 'payment'],
    optional: [
      'authentication',
      'content_management',
      'object_storage',
      'background_jobs',
      'authorization',
    ],
  },
  MOBILE_APPLICATION: {
    required: ['mobile_framework'],
    optional: ['backend', 'database', 'authentication', 'object_storage'],
  },
  /*
   * Android-only and iOS-only projects name exactly one native category. The
   * other is `not_applicable` — offering an iOS framework on an Android-only
   * brief is how a stack acquires a platform the client is not paying for.
   */
  ANDROID_APPLICATION: {
    required: ['native_android'],
    optional: ['backend', 'database', 'authentication', 'object_storage'],
  },
  IOS_APPLICATION: {
    required: ['native_ios'],
    optional: ['backend', 'database', 'authentication', 'object_storage'],
  },
  CROSS_PLATFORM_MOBILE: {
    required: ['mobile_framework'],
    optional: ['backend', 'database', 'authentication', 'object_storage'],
  },
  DESKTOP_APPLICATION: {
    required: ['desktop_framework'],
    optional: ['database', 'backend', 'object_storage'],
  },
  /* No frontend. Deliberately absent rather than optional. */
  BACKEND_API: {
    required: ['backend', 'database'],
    optional: ['authentication', 'authorization', 'object_storage', 'background_jobs'],
  },
  /*
   * `vector_storage` is conditional here as everywhere. An AI project is not
   * automatically a retrieval project, and a vector database added because the
   * brief says "AI" is a service the client operates forever for nothing.
   * `ai_runtime` is not required either — an application calling a hosted model
   * runs no inference itself.
   */
  AI_ML_SOLUTION: {
    required: ['ai_model'],
    optional: ['ai_runtime', 'backend', 'database', 'object_storage', 'background_jobs'],
  },
  AUTOMATION_WORKFLOW: {
    required: ['backend'],
    optional: ['background_jobs', 'database', 'integrations', 'ai_model'],
  },
  SYSTEM_INTEGRATION: {
    required: ['integrations', 'backend'],
    optional: ['database', 'background_jobs', 'object_storage'],
  },
  MIGRATION: {
    required: ['database'],
    optional: ['backend', 'object_storage', 'background_jobs'],
  },
  MODERNISATION: {
    required: ['backend'],
    optional: ['web_frontend', 'database', 'authentication', 'containerization'],
  },
  /*
   * Enhancement work inherits a stack rather than choosing one. Nothing is
   * required: the existing technologies are recorded as
   * EXISTING_INFRASTRUCTURE, and what is genuinely new is added.
   */
  APPLICATION_ENHANCEMENT: {
    required: [],
    optional: ['web_frontend', 'backend', 'database', 'mobile_framework', 'authentication'],
  },
  MULTI_PLATFORM_PRODUCT: {
    required: ['backend', 'database'],
    optional: [
      'web_frontend',
      'mobile_framework',
      'native_android',
      'native_ios',
      'desktop_framework',
      'authentication',
      'object_storage',
    ],
  },
  /*
   * Nothing is assumed. "Other" means the list did not describe it, and
   * deriving a category plan from that would be inventing a project type — the
   * exact thing the specification forbids. Everything is optional, and the UI
   * asks for the type to be confirmed before recommending anything.
   */
  OTHER: {
    required: [],
    optional: [...TECHNOLOGY_CATEGORIES],
  },
};

/** Why each category is where it is, in the user's terms. */
const REASONS: Readonly<Partial<Record<TechnologyCategory, string>>> = {
  web_frontend: 'Something has to render in a browser.',
  backend: 'Your requirements describe logic that cannot run on the client alone.',
  database: 'Your requirements describe information that has to be stored and read back.',
  mobile_framework: 'The app has to be built for a mobile platform.',
  native_android: 'This project targets Android.',
  native_ios: 'This project targets iOS.',
  desktop_framework: 'The app has to be installed on a desktop machine.',
  payment: 'Your requirements describe taking money.',
  authentication: 'Your requirements describe people signing in.',
  ai_model: 'Your requirements describe a model producing something.',
  integrations: 'Your requirements describe talking to systems you do not own.',
};

const CONDITIONAL_REASON =
  'Only if something in your approved requirements needs it. It is not added on the basis of project size.';

const OPTIONAL_REASON = 'Reasonable for a project like this. You can approve without deciding it.';

const NOT_APPLICABLE_REASON = 'Projects of this type do not have one.';

/**
 * The category plan for a set of project types.
 *
 * A project may be several types at once — a SaaS platform with a mobile
 * companion — so the plans are merged with the strongest applicability winning.
 * A category required by any one type is required overall, because the project
 * genuinely cannot be delivered without it.
 */
export function planCategories(
  projectTypes: readonly ProjectType[],
): readonly CategoryApplicabilityEntry[] {
  const strongest = new Map<TechnologyCategory, CategoryApplicability>();

  const raise = (category: TechnologyCategory, level: CategoryApplicability): void => {
    const held = strongest.get(category);

    if (!held || RANK[level] > RANK[held]) {
      strongest.set(category, level);
    }
  };

  for (const type of projectTypes) {
    const plan = PLANS[type];

    if (!plan) {
      continue;
    }

    for (const category of plan.required) {
      raise(category, 'required');
    }

    for (const category of [...plan.optional, ...UNIVERSAL_OPTIONAL]) {
      raise(category, 'optional');
    }
  }

  return TECHNOLOGY_CATEGORIES.map((category) => {
    // A justification-required category is conditional wherever it appears, and
    // no project type can promote it. That is the rule that keeps Redis, Kafka
    // and a vector database out of a stack that has no need of them.
    const applicability: CategoryApplicability = requiresJustification(category)
      ? 'conditional'
      : (strongest.get(category) ?? 'not_applicable');

    return {
      category,
      applicability,
      reason: reasonFor(category, applicability),
      justifiedBy: [],
    };
  });
}

const RANK: Readonly<Record<CategoryApplicability, number>> = {
  not_applicable: 0,
  conditional: 1,
  optional: 2,
  required: 3,
};

function reasonFor(category: TechnologyCategory, applicability: CategoryApplicability): string {
  if (applicability === 'required') {
    return REASONS[category] ?? 'This project cannot be delivered without deciding it.';
  }

  if (applicability === 'conditional') {
    return CONDITIONAL_REASON;
  }

  if (applicability === 'optional') {
    return OPTIONAL_REASON;
  }

  return NOT_APPLICABLE_REASON;
}

/**
 * Whether the project type is settled enough to recommend against.
 *
 * `OTHER` is not, and neither is an empty selection. Both surface a
 * confirmation rather than a stack — inventing a project type in order to have
 * something to recommend from is how a plausible, wrong architecture reaches a
 * proposal.
 */
export function projectTypeIsActionable(projectTypes: readonly ProjectType[]): boolean {
  return projectTypes.length > 0 && !projectTypes.includes('OTHER');
}

/** Categories that must reach a decision before the stack can be approved. */
export function requiredCategories(
  plan: readonly CategoryApplicabilityEntry[],
): readonly TechnologyCategory[] {
  return plan.filter((entry) => entry.applicability === 'required').map((entry) => entry.category);
}
