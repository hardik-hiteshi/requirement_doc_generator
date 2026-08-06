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
} as const;
