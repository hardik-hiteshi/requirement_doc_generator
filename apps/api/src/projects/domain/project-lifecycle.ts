import {
  canTransition,
  isDeleted,
  isMutable,
  isReadable,
  type ProjectStatus,
} from '@wdrg/contracts';

import type { ProjectRecord } from '../project.repository';

/**
 * The project state machine, as pure functions.
 *
 * Free of Nest, Mongo and HTTP so the rules can be tested directly and reused
 * by any caller. Every decision about whether a project may be read or changed
 * routes through here rather than being re-derived at each call site — that is
 * what stops one endpoint quietly accepting writes to an expired project.
 */

export type AccessDecision =
  | { readonly allowed: true; readonly status: ProjectStatus }
  | { readonly allowed: false; readonly reason: 'EXPIRED' | 'DELETED' };

/**
 * Resolves the status a project *actually* has right now.
 *
 * Expiry is evaluated lazily on access rather than by a background sweep: with
 * no scheduler in this phase, a stored status would go stale the moment the
 * expiry timestamp passed, and every caller would have to remember to compare
 * against the clock. Deriving it here means there is one answer.
 */
export function effectiveStatus(project: ProjectRecord, now: Date): ProjectStatus {
  if (isDeleted(project.status)) {
    return project.status;
  }

  if (project.expiresAt.getTime() <= now.getTime()) {
    return 'EXPIRED';
  }

  return project.status;
}

/** Whether the project's data may be returned. */
export function canRead(project: ProjectRecord, now: Date): AccessDecision {
  const status = effectiveStatus(project, now);

  if (isDeleted(status)) {
    return { allowed: false, reason: 'DELETED' };
  }

  // An expired project is still readable: the user should be able to see what
  // they had and copy it out, even though they can no longer change it.
  return isReadable(status) ? { allowed: true, status } : { allowed: false, reason: 'EXPIRED' };
}

/** Whether the project may be modified. */
export function canWrite(project: ProjectRecord, now: Date): AccessDecision {
  const status = effectiveStatus(project, now);

  if (isDeleted(status)) {
    return { allowed: false, reason: 'DELETED' };
  }

  return isMutable(status) ? { allowed: true, status } : { allowed: false, reason: 'EXPIRED' };
}

/**
 * The status a project should hold after a successful edit.
 *
 * A project becomes `ACTIVE` on its first real edit. `DRAFT` means "created but
 * untouched", which is what lets a later cleanup distinguish an abandoned
 * accidental creation from a project someone actually worked on.
 */
export function statusAfterEdit(current: ProjectStatus): ProjectStatus {
  if (current === 'DRAFT') {
    return 'ACTIVE';
  }

  return current;
}

/**
 * Validates a transition before it is written.
 *
 * @throws never — returns a decision so the caller maps it to the right error.
 */
export function assertTransition(
  from: ProjectStatus,
  to: ProjectStatus,
): { readonly valid: boolean; readonly reason?: string } {
  if (from === to) {
    return { valid: true };
  }

  if (!canTransition(from, to)) {
    return { valid: false, reason: `Cannot move a project from ${from} to ${to}.` };
  }

  return { valid: true };
}

/** Expiry timestamp for a project created or renewed now. */
export function calculateExpiry(now: Date, expiryDays: number): Date {
  return new Date(now.getTime() + expiryDays * 86_400_000);
}

/** Whole days until expiry, floored at zero. For display only. */
export function daysUntilExpiry(project: ProjectRecord, now: Date): number {
  const remaining = project.expiresAt.getTime() - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / 86_400_000);
}
