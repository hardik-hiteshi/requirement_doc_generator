/** Stable service identity, used in logs, health payloads and OpenAPI metadata. */
export const API_SERVICE_NAME = 'wdrg-api' as const;

/**
 * Service version reported by the liveness probe.
 *
 * Kept as a constant rather than read from package.json so the compiled bundle
 * has no filesystem dependency at runtime. Bumped as part of the release
 * checklist.
 */
export const API_SERVICE_VERSION = '0.1.0' as const;
