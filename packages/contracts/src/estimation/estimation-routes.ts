import { buildApiPath } from '../http/api-routes';

/**
 * Phase 6 endpoints.
 *
 * Every route hangs off `projects/current`, exactly as Phases 3 to 5 do. The
 * project comes from the verified session, so an estimate id in a path
 * identifies a record inside the caller's own project and there is no request
 * shape in which one project can name another's plan.
 */
export const ESTIMATION_ROUTES = {
  /** GET — the current estimate, with its schedule, capacity and feasibility. */
  estimate: buildApiPath('projects/current/estimation'),
  /** GET — every version, newest first. */
  versions: buildApiPath('projects/current/estimation/versions'),
  /** GET — one earlier version, exactly as it stood. */
  version: (version: string) => buildApiPath('projects/current/estimation/versions', version),

  /** POST — ask the AI to estimate the categories nobody has. */
  run: buildApiPath('projects/current/estimation/run'),
  /** GET — the current or most recent estimation run. */
  currentRun: buildApiPath('projects/current/estimation/run/current'),

  /** POST — add an estimate by hand. Works with no inference at all. */
  estimates: buildApiPath('projects/current/estimation/estimates'),
  /** PATCH — override one. */
  estimateUnit: (estimateId: string) =>
    buildApiPath('projects/current/estimation/estimates', estimateId),
  /** POST — put one back to the calculated figure. */
  resetEstimate: (estimateId: string) =>
    buildApiPath('projects/current/estimation/estimates', estimateId, 'reset'),

  /** POST — add a dependency. */
  dependencies: buildApiPath('projects/current/estimation/dependencies'),
  /** DELETE — remove one. */
  dependency: (dependencyId: string) =>
    buildApiPath('projects/current/estimation/dependencies', dependencyId),

  /** PUT — the working calendar. */
  calendar: buildApiPath('projects/current/estimation/calendar'),
  /** PUT — the team, per role. */
  team: buildApiPath('projects/current/estimation/team'),
  /** PUT — what is known about an existing codebase. */
  existingSystem: buildApiPath('projects/current/estimation/existing-system'),

  /** POST — recalculate the schedule only. Used after a start-date change. */
  recalculateSchedule: buildApiPath('projects/current/estimation/schedule/recalculate'),

  /** POST — record that a tight or high-risk timeline was read and accepted. */
  acknowledgeRisk: buildApiPath('projects/current/estimation/risk/acknowledge'),

  /** POST — approve the estimate. */
  approve: buildApiPath('projects/current/estimation/approve'),
  /** POST — reopen an approved estimate as a new version. */
  reopen: buildApiPath('projects/current/estimation/reopen'),
} as const;
