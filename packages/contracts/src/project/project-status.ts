/**
 * Project lifecycle.
 *
 * ```
 *            create
 *              │
 *              ▼
 *          ┌────────┐   first save    ┌────────┐
 *          │ DRAFT  │ ──────────────▶ │ ACTIVE │
 *          └───┬────┘                 └───┬────┘
 *              │                          │
 *              │  expiry passes           │  expiry passes
 *              ▼                          ▼
 *          ┌──────────────────────────────────┐
 *          │             EXPIRED              │
 *          └───────────────┬──────────────────┘
 *                          │
 *   delete requested from any of the above
 *                          ▼
 *              ┌────────────────────┐  retention window  ┌─────────┐
 *              │ DELETION_PENDING   │ ─────────────────▶ │ DELETED │
 *              └────────────────────┘                    └─────────┘
 * ```
 *
 * `DELETION_PENDING` exists so a deletion is acknowledged immediately — the
 * session is invalidated and the project becomes unreadable — while the record
 * itself survives long enough for the audit trail to remain coherent. The
 * cleanup job that completes the move to `DELETED` arrives with the retention
 * work in Phase 12; until then a project stays in `DELETION_PENDING`, which is
 * already terminal from a user's point of view.
 */
export const PROJECT_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'EXPIRED',
  'DELETION_PENDING',
  'DELETED',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Permitted transitions. Anything absent is rejected by the domain rather than
 * silently applied — an unexpected transition is a bug, not a state to tolerate.
 */
export const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> =
  {
    DRAFT: ['ACTIVE', 'EXPIRED', 'DELETION_PENDING'],
    ACTIVE: ['EXPIRED', 'DELETION_PENDING'],
    EXPIRED: ['DELETION_PENDING'],
    // Terminal for the user. Only the retention job advances it.
    DELETION_PENDING: ['DELETED'],
    DELETED: [],
  };

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses whose data a caller may still read. */
export const READABLE_STATUSES: readonly ProjectStatus[] = ['DRAFT', 'ACTIVE', 'EXPIRED'];

/** Statuses that still accept modification. */
export const MUTABLE_STATUSES: readonly ProjectStatus[] = ['DRAFT', 'ACTIVE'];

export function isReadable(status: ProjectStatus): boolean {
  return READABLE_STATUSES.includes(status);
}

export function isMutable(status: ProjectStatus): boolean {
  return MUTABLE_STATUSES.includes(status);
}

/**
 * True once a project should be treated as gone, whichever of the two deletion
 * states it is in. Callers use this rather than comparing to `DELETED`, so a
 * project awaiting cleanup is never accidentally treated as live.
 */
export function isDeleted(status: ProjectStatus): boolean {
  return status === 'DELETION_PENDING' || status === 'DELETED';
}
