import { z } from 'zod';

/**
 * What kind of thing is being built.
 *
 * Captured with the project details because every later phase branches on it:
 * the technology-stack categories offered, the roles an estimate assumes, how
 * effort is allocated, what testing and deployment activities exist, the WBS
 * task list, the terminology the Statement of Work uses, and which client
 * dependencies apply. A stack recommendation or estimate produced without
 * knowing the project type is guesswork dressed as analysis.
 *
 * **Phase 2 collects this value and nothing more.** Nothing here changes any
 * recommendation or calculation yet — the stack decision (Phase 5), estimation
 * (Phase 6) and document generation (Phases 7–9) are where it takes effect.
 */
export const PROJECT_TYPES = [
  'WEBSITE',
  'WEB_APPLICATION',
  'MOBILE_APPLICATION',
  'DESKTOP_APPLICATION',
  'SAAS_PLATFORM',
  'BACKEND_API',
  'AI_ML_SOLUTION',
  'AUTOMATION_WORKFLOW',
  'SYSTEM_INTEGRATION',
  'MIGRATION',
  'MODERNISATION',
  'MULTI_PLATFORM_PRODUCT',
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Readonly<Record<ProjectType, string>> = {
  WEBSITE: 'Website',
  WEB_APPLICATION: 'Web application',
  MOBILE_APPLICATION: 'Mobile application',
  DESKTOP_APPLICATION: 'Desktop application',
  SAAS_PLATFORM: 'SaaS platform',
  BACKEND_API: 'Backend / API system',
  AI_ML_SOLUTION: 'AI / ML solution',
  AUTOMATION_WORKFLOW: 'Automation workflow',
  SYSTEM_INTEGRATION: 'System integration',
  MIGRATION: 'Migration',
  MODERNISATION: 'Modernisation',
  MULTI_PLATFORM_PRODUCT: 'Multi-platform product',
};

export const PROJECT_TYPE_DESCRIPTIONS: Readonly<Record<ProjectType, string>> = {
  WEBSITE: 'Primarily content and presentation, with limited application logic.',
  WEB_APPLICATION: 'Browser-based application with substantial business logic.',
  MOBILE_APPLICATION: 'iOS, Android or cross-platform mobile app.',
  DESKTOP_APPLICATION: 'Installed application for Windows, macOS or Linux.',
  SAAS_PLATFORM: 'Multi-tenant subscription product, usually with billing and onboarding.',
  BACKEND_API: 'Services and APIs consumed by other systems rather than end users.',
  AI_ML_SOLUTION: 'Model-backed capability: inference, training or data pipelines.',
  AUTOMATION_WORKFLOW: 'Scheduled or event-driven process automation.',
  SYSTEM_INTEGRATION: 'Connecting existing systems, with mapping and transformation.',
  MIGRATION: 'Moving data, workloads or users from one system to another.',
  MODERNISATION: 'Re-platforming or refactoring an existing system.',
  MULTI_PLATFORM_PRODUCT: 'One product delivered across several platforms at once.',
};

/** Maximum distinct types on one project, so the selection stays meaningful. */
export const MAX_PROJECT_TYPES = 4;

/**
 * Selected as an array because real briefs frequently span more than one type —
 * a SaaS platform with a mobile companion, or a migration that also modernises.
 * Forcing a single choice would push that nuance into free text, where no later
 * phase can act on it.
 */
export const projectTypeSelectionSchema = z
  .array(z.enum(PROJECT_TYPES))
  .min(1)
  .max(MAX_PROJECT_TYPES)
  .refine(
    (types) => new Set(types).size === types.length,
    'Each project type may appear only once',
  );

export type ProjectTypeSelection = z.infer<typeof projectTypeSelectionSchema>;

/**
 * Whether the project type is known well enough for the phases that depend on
 * it. Used by the workspace to explain why the stack and estimation steps stay
 * locked, and by those phases to refuse to proceed on an assumption.
 */
export function hasProjectType(types: readonly ProjectType[] | undefined): boolean {
  return Array.isArray(types) && types.length > 0;
}
