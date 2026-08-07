/**
 * Central registry of TanStack Query cache keys.
 *
 * Keys live here rather than inline at each call site so an invalidation after a
 * mutation cannot miss a cache entry because two components spelled the same key
 * differently.
 */
export const queryKeys = {
  health: ['health'] as const,
  currentProject: ['project', 'current'] as const,

  /* Phase 3 — requirement ingestion. */
  sources: ['sources'] as const,
  source: (sourceId: string) => ['sources', sourceId] as const,

  /* Phase 4 — requirement analysis. */
  analysisRun: ['analysis', 'run'] as const,
  requirements: ['analysis', 'requirements'] as const,
  findings: ['analysis', 'findings'] as const,
  clarifications: ['analysis', 'clarifications'] as const,
  baseline: ['analysis', 'baseline'] as const,
  baselineVersions: ['analysis', 'baseline', 'versions'] as const,
} as const;
