import { buildApiPath } from '../http/api-routes';

/**
 * Phase 3 endpoints.
 *
 * Every route hangs off `projects/current`, never off a project id. The project
 * comes from the verified session, so — exactly as in Phase 2 — there is no
 * request shape in which a caller can name a project it has not authenticated
 * for. A source id in the path is scoped by that session, so it identifies a
 * source *within the caller's own project* and nothing else.
 */
export const REQUIREMENT_ROUTES = {
  /** GET — every source in the project, with usage against the quota. */
  sources: buildApiPath('projects/current/sources'),
  /** POST — add a pasted-text source. */
  textSources: buildApiPath('projects/current/sources/text'),
  /** POST — multipart upload of one or more files. */
  uploads: buildApiPath('projects/current/sources/files'),

  /** GET / DELETE a single source. */
  source: (sourceId: string) => buildApiPath('projects/current/sources', sourceId),
  /** PUT — edit a pasted-text source. */
  textSource: (sourceId: string) => buildApiPath('projects/current/sources', sourceId, 'text'),
  /** GET — the effective extracted content, with the original alongside it. */
  content: (sourceId: string) => buildApiPath('projects/current/sources', sourceId, 'content'),
  /** PUT — save corrections as a new revision. */
  corrections: (sourceId: string) =>
    buildApiPath('projects/current/sources', sourceId, 'content/corrections'),
  /** POST — discard corrections and go back to the original extraction. */
  restore: (sourceId: string) =>
    buildApiPath('projects/current/sources', sourceId, 'content/restore'),
  /** POST — mark the source reviewed. */
  review: (sourceId: string) => buildApiPath('projects/current/sources', sourceId, 'review'),
  /** POST — retry a failed source from its last safe stage. */
  retry: (sourceId: string) => buildApiPath('projects/current/sources', sourceId, 'retry'),
  /** GET — the original uploaded file, streamed through an authorized route. */
  download: (sourceId: string) => buildApiPath('projects/current/sources', sourceId, 'download'),
} as const;

/** Template forms, for OpenAPI and for the controller decorators. */
export const REQUIREMENT_ROUTE_TEMPLATES = {
  sources: REQUIREMENT_ROUTES.sources,
  textSources: REQUIREMENT_ROUTES.textSources,
  uploads: REQUIREMENT_ROUTES.uploads,
  source: REQUIREMENT_ROUTES.source(':sourceId'),
  textSource: REQUIREMENT_ROUTES.textSource(':sourceId'),
  content: REQUIREMENT_ROUTES.content(':sourceId'),
  corrections: REQUIREMENT_ROUTES.corrections(':sourceId'),
  restore: REQUIREMENT_ROUTES.restore(':sourceId'),
  review: REQUIREMENT_ROUTES.review(':sourceId'),
  retry: REQUIREMENT_ROUTES.retry(':sourceId'),
  download: REQUIREMENT_ROUTES.download(':sourceId'),
} as const;

/** The multipart field name the upload endpoint reads. */
export const UPLOAD_FIELD_NAME = 'files';
