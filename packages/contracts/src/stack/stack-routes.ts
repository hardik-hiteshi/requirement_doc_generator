import { buildApiPath } from '../http/api-routes';

/**
 * Phase 5 endpoints.
 *
 * Every route hangs off `projects/current`, exactly as Phases 3 and 4 do. The
 * project comes from the verified session, so a component id in a path
 * identifies a record inside the caller's own project and there is no request
 * shape in which one project can name another's stack.
 */
export const STACK_ROUTES = {
  /** GET — the current stack snapshot, with its plan, findings and blockers. */
  stack: buildApiPath('projects/current/stack'),
  /** GET — every version of the stack, newest first. */
  stackVersions: buildApiPath('projects/current/stack/versions'),
  /** GET — one earlier version, exactly as it stood. */
  stackVersion: (version: string) => buildApiPath('projects/current/stack/versions', version),

  /** PUT — choose how the stack gets filled in. */
  mode: buildApiPath('projects/current/stack/mode'),
  /** GET — the categories this project has, and why. */
  categories: buildApiPath('projects/current/stack/categories'),
  /** GET — the technology catalogue, filtered to this project. */
  catalog: buildApiPath('projects/current/stack/catalog'),

  /** POST — choose a technology for a category. */
  components: buildApiPath('projects/current/stack/components'),
  /** PATCH — change one. DELETE — remove it from the stack. */
  component: (componentId: string) =>
    buildApiPath('projects/current/stack/components', componentId),
  /** POST — accept, reject or replace an AI recommendation. */
  decideComponent: (componentId: string) =>
    buildApiPath('projects/current/stack/components', componentId, 'decision'),
  /** POST — seal one component. */
  lockComponent: (componentId: string) =>
    buildApiPath('projects/current/stack/components', componentId, 'lock'),
  /** POST — unlock it. A separate route, because it is a separate decision. */
  unlockComponent: (componentId: string) =>
    buildApiPath('projects/current/stack/components', componentId, 'unlock'),

  /** POST — ask the AI to fill the undecided categories. */
  recommendations: buildApiPath('projects/current/stack/recommendations'),
  /** GET — the current or most recent recommendation run. */
  currentRecommendationRun: buildApiPath('projects/current/stack/recommendations/current'),

  /** POST — record that a risk was read and the choice kept anyway. */
  acknowledgeRisk: buildApiPath('projects/current/stack/risks/acknowledge'),

  /** POST — approve the stack. */
  approve: buildApiPath('projects/current/stack/approve'),
  /** POST — lock it, which makes it authoritative for every later phase. */
  lock: buildApiPath('projects/current/stack/lock'),
  /** POST — reopen a locked stack, deliberately. */
  unlock: buildApiPath('projects/current/stack/unlock'),

  /** GET — the contract a locked stack hands downstream. */
  authority: buildApiPath('projects/current/stack/authority'),
} as const;
