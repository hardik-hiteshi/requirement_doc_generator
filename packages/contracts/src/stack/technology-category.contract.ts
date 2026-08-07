import { z } from 'zod';

/**
 * The slots a technology stack can have.
 *
 * A closed list, because every later phase reads it: estimation prices work per
 * category, the Statement of Work names them, and the Client Dependency Sheet
 * asks who provides what. A free-text category would be untraceable by the time
 * it reached a document a client signs.
 *
 * **Categories are offered, never required.** An API-only project has no web
 * frontend and a static website has no database; forcing every project to fill
 * every slot produces a stack full of technologies nobody asked for, and an
 * estimate that prices them. Applicability comes from the project type and the
 * approved requirements — see `project-type-categories.ts`.
 */
export const TECHNOLOGY_CATEGORIES = [
  'web_frontend',
  'backend',
  'mobile_framework',
  'native_android',
  'native_ios',
  'desktop_framework',
  'database',
  'cache',
  'search',
  'vector_storage',
  'object_storage',
  'authentication',
  'authorization',
  'api_gateway',
  'message_queue',
  'realtime',
  'payment',
  'ai_runtime',
  'ai_model',
  'data_processing',
  'background_jobs',
  'integrations',
  'hosting',
  'containerization',
  'ci_cd',
  'monitoring',
  'logging',
  'analytics',
  'testing',
  'security_tooling',
  'content_management',
  'other',
] as const;

export type TechnologyCategory = (typeof TECHNOLOGY_CATEGORIES)[number];
export const technologyCategorySchema = z.enum(TECHNOLOGY_CATEGORIES);

export const TECHNOLOGY_CATEGORY_LABELS: Readonly<Record<TechnologyCategory, string>> = {
  web_frontend: 'Web frontend',
  backend: 'Backend',
  mobile_framework: 'Mobile framework',
  native_android: 'Native Android',
  native_ios: 'Native iOS',
  desktop_framework: 'Desktop framework',
  database: 'Database',
  cache: 'Cache',
  search: 'Search',
  vector_storage: 'Vector storage',
  object_storage: 'File / object storage',
  authentication: 'Authentication',
  authorization: 'Authorisation',
  api_gateway: 'API gateway',
  message_queue: 'Message queue',
  realtime: 'Real-time communication',
  payment: 'Payment provider',
  ai_runtime: 'AI / ML runtime',
  ai_model: 'AI model',
  data_processing: 'Data processing',
  background_jobs: 'Background jobs',
  integrations: 'Third-party integrations',
  hosting: 'Cloud / hosting',
  containerization: 'Containerisation',
  ci_cd: 'CI / CD',
  monitoring: 'Monitoring',
  logging: 'Logging',
  analytics: 'Analytics',
  testing: 'Testing',
  security_tooling: 'Security tooling',
  content_management: 'Content management',
  other: 'Other',
};

/**
 * How many technologies may occupy a category.
 *
 * `one` categories reject a second entry outright — a project does not have two
 * primary databases without someone having decided that on purpose, and a model
 * proposing both PostgreSQL and MySQL for `database` has produced a conflict
 * rather than a recommendation. `many` categories genuinely hold several:
 * a project integrates with three services and tests at four levels.
 */
export const CATEGORY_CARDINALITY: Readonly<Record<TechnologyCategory, 'one' | 'many'>> = {
  web_frontend: 'one',
  backend: 'one',
  mobile_framework: 'one',
  native_android: 'one',
  native_ios: 'one',
  desktop_framework: 'one',
  database: 'one',
  cache: 'one',
  search: 'one',
  vector_storage: 'one',
  object_storage: 'one',
  authentication: 'one',
  authorization: 'one',
  api_gateway: 'one',
  message_queue: 'one',
  realtime: 'one',
  payment: 'many',
  ai_runtime: 'one',
  ai_model: 'many',
  data_processing: 'many',
  background_jobs: 'one',
  integrations: 'many',
  hosting: 'one',
  containerization: 'one',
  ci_cd: 'one',
  monitoring: 'one',
  logging: 'one',
  analytics: 'many',
  testing: 'many',
  security_tooling: 'many',
  content_management: 'one',
  other: 'many',
};

export function allowsMultiple(category: TechnologyCategory): boolean {
  return CATEGORY_CARDINALITY[category] === 'many';
}

/**
 * Categories that never appear unless a requirement asks for them.
 *
 * The expensive mistakes in a stack recommendation are all of this shape: a
 * vector database because the brief mentions AI, Kafka because it mentions
 * events, Kubernetes because it mentions scale. Each one adds infrastructure,
 * operational burden and cost to an estimate a client is asked to sign.
 *
 * A category listed here is not offered, not recommended and not counted as
 * missing unless something in the approved baseline justifies it. The
 * justification is a requirement id, and it is recorded.
 */
export const JUSTIFICATION_REQUIRED_CATEGORIES: readonly TechnologyCategory[] = [
  'cache',
  'search',
  'vector_storage',
  'message_queue',
  'api_gateway',
  'realtime',
  'containerization',
  'data_processing',
];

export function requiresJustification(category: TechnologyCategory): boolean {
  return JUSTIFICATION_REQUIRED_CATEGORIES.includes(category);
}

/** Why a category is or is not part of this project's stack. */
export const CATEGORY_APPLICABILITIES = [
  /** Part of the stack and must reach a disposition before approval. */
  'required',
  /** Offered, but the stack may be approved without it. */
  'optional',
  /** Only if a requirement justifies it. Not counted as missing otherwise. */
  'conditional',
  /** Does not exist for this project. A frontend on an API-only service. */
  'not_applicable',
] as const;

export type CategoryApplicability = (typeof CATEGORY_APPLICABILITIES)[number];
export const categoryApplicabilitySchema = z.enum(CATEGORY_APPLICABILITIES);

export const CATEGORY_APPLICABILITY_LABELS: Readonly<Record<CategoryApplicability, string>> = {
  required: 'Needed',
  optional: 'Optional',
  conditional: 'Only if your requirements need it',
  not_applicable: 'Not part of this project',
};

/**
 * One category as it applies to one project.
 *
 * `reason` is shown to the user, so it says why in their terms — *"your
 * requirements describe a catalogue and orders, which need to be stored"* —
 * rather than naming the rule that produced it.
 */
export const categoryApplicabilityEntrySchema = z
  .object({
    category: technologyCategorySchema,
    applicability: categoryApplicabilitySchema,
    reason: z.string().min(1).max(300),
    /** Requirement ids that made this conditional category applicable. */
    justifiedBy: z.array(z.string().max(64)).max(20),
  })
  .strict();

export type CategoryApplicabilityEntry = z.infer<typeof categoryApplicabilityEntrySchema>;
