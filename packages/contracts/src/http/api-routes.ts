/** Global path prefix applied to every API route. */
export const API_PREFIX = 'api' as const;

/** Current API major version. Routes are versioned via the URI. */
export const API_VERSION = '1' as const;

/** Where the generated OpenAPI document is served. */
export const OPENAPI_PATH = `/${API_PREFIX}/docs` as const;

/** Where the raw OpenAPI JSON document is served. */
export const OPENAPI_JSON_PATH = `/${API_PREFIX}/docs-json` as const;

/**
 * Operational endpoints are deliberately version-neutral: probes and dashboards
 * must not have to change when the business API version changes.
 */
export const HEALTH_ROUTES = {
  liveness: `/${API_PREFIX}/health/live`,
  readiness: `/${API_PREFIX}/health/ready`,
} as const;

/**
 * Builds a versioned API path.
 *
 * @example buildApiPath('projects') -> '/api/v1/projects'
 */
export function buildApiPath(...segments: readonly string[]): string {
  const path = segments
    .flatMap((segment) => segment.split('/'))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');

  return `/${API_PREFIX}/v${API_VERSION}${path.length > 0 ? `/${path}` : ''}`;
}
