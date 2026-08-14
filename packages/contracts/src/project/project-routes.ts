import { buildApiPath } from '../http/api-routes';

/**
 * Phase 2 endpoints.
 *
 * Section updates are separate `PUT`s rather than one large `PATCH` because each
 * section has its own schema, its own audit event and its own save state in the
 * UI. A single endpoint would have to accept a partial of everything, which
 * makes both validation and "what exactly changed" ambiguous.
 */
export const PROJECT_ROUTES = {
  /** POST — create an anonymous project. No session required. */
  create: buildApiPath('projects'),
  /** POST — exchange a recovery secret for a session cookie. No session required. */
  exchange: buildApiPath('projects/session'),
  /** DELETE — end the current session. */
  endSession: buildApiPath('projects/session'),
  /** GET — read the project the session is bound to. */
  current: buildApiPath('projects/current'),

  details: buildApiPath('projects/current/details'),
  timeline: buildApiPath('projects/current/timeline'),
  startDate: buildApiPath('projects/current/start-date'),
  teamCapacity: buildApiPath('projects/current/team-capacity'),
  outputPreferences: buildApiPath('projects/current/output-preferences'),

  /** GET/PUT — how exported documents are presented. Presentation only. */
  branding: buildApiPath('projects/current/branding'),

  /** POST — the optional logo, stored like any other upload and scanned the same way. */
  brandingLogo: buildApiPath('projects/current/branding/logo'),

  /** DELETE — request deletion of the current project. */
  delete: buildApiPath('projects/current'),
} as const;

/**
 * Operations that mutate state, and therefore require the CSRF header in
 * addition to the session cookie.
 */
export const CSRF_PROTECTED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
