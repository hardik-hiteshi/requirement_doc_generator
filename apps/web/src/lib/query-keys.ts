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
  proposals: ['analysis', 'proposals'] as const,
  requirementHistory: (itemId: string) => ['analysis', 'requirements', itemId, 'history'] as const,
  conflictHistory: (conflictId: string) =>
    ['analysis', 'conflicts', conflictId, 'history'] as const,
  baseline: ['analysis', 'baseline'] as const,
  baselineVersions: ['analysis', 'baseline', 'versions'] as const,

  /* Phase 5 — technology stack. */
  stack: ['stack'] as const,
  stackVersions: ['stack', 'versions'] as const,
  stackCatalog: ['stack', 'catalog'] as const,
  stackRecommendationRun: ['stack', 'recommendations', 'run'] as const,

  /* Phase 6 — estimation and timeline. */
  estimate: ['estimate'] as const,
  estimateVersions: ['estimate', 'versions'] as const,
  estimationRun: ['estimate', 'run'] as const,
} as const;
