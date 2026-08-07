import { z } from 'zod';

/**
 * Who decided a technology, and therefore who may change it.
 *
 * The single rule this phase exists to enforce. A person who types *"backend:
 * Laravel"* has made a decision, and a model that would have said NestJS does
 * not get to quietly disagree by writing over it. Everything else here — the
 * statuses, the transitions, the recommendation filter — is machinery for
 * making that rule hold in code rather than in a code review.
 *
 * ## The precedence
 *
 * ```
 * LOCKED_USER_SELECTION            a decision, sealed
 *   > USER_APPROVED                a decision, reviewed
 *     > USER_SELECTED              a decision
 *       > AI_RECOMMENDATION        a suggestion
 *         > UNDEFINED              nothing yet
 * ```
 *
 * A recommendation may only occupy a slot at or below its own level, which
 * means the only slot it can occupy is an empty one. It can *warn* about
 * anything — incompatibility, licence, delivery risk, a requirement it does not
 * satisfy — and a warning is loud, permanent and carried into the estimate. It
 * is not a replacement.
 */
export const STACK_AUTHORITY_LEVELS = [
  'UNDEFINED',
  'AI_RECOMMENDATION',
  'USER_SELECTED',
  'USER_APPROVED',
  'LOCKED_USER_SELECTION',
] as const;

export type StackAuthorityLevel = (typeof STACK_AUTHORITY_LEVELS)[number];
export const stackAuthorityLevelSchema = z.enum(STACK_AUTHORITY_LEVELS);

/**
 * Rank, ascending. Higher wins.
 *
 * Derived from the array order rather than written twice, so the precedence
 * cannot drift from the list it is supposed to describe.
 */
export const AUTHORITY_RANK: Readonly<Record<StackAuthorityLevel, number>> = Object.fromEntries(
  STACK_AUTHORITY_LEVELS.map((level, index) => [level, index]),
) as Record<StackAuthorityLevel, number>;

export const STACK_AUTHORITY_LABELS: Readonly<Record<StackAuthorityLevel, string>> = {
  UNDEFINED: 'Not decided',
  AI_RECOMMENDATION: 'Suggested by the AI',
  USER_SELECTED: 'Your choice',
  USER_APPROVED: 'Your choice, reviewed',
  LOCKED_USER_SELECTION: 'Locked',
};

/**
 * Whether something at `incoming` authority may take a slot held at `held`.
 *
 * Strictly greater, not greater-or-equal. Two things sit behind that: a
 * recommendation must never displace another recommendation without the user
 * seeing it happen, and re-running recommendation over an already-recommended
 * stack must be idempotent rather than a slow random walk.
 */
export function canOverride(incoming: StackAuthorityLevel, held: StackAuthorityLevel): boolean {
  return AUTHORITY_RANK[incoming] > AUTHORITY_RANK[held];
}

/**
 * Whether the AI may write into a slot at this authority.
 *
 * The one function every recommendation path goes through. Deliberately not
 * expressed as `canOverride(AI_RECOMMENDATION, held)` even though it computes
 * the same thing — a reader auditing "can the model touch this?" should find a
 * function that answers that question by name.
 */
export function aiMayOccupy(held: StackAuthorityLevel): boolean {
  return held === 'UNDEFINED' || held === 'AI_RECOMMENDATION';
}

/* -------------------------------------------------------- statuses */

/**
 * Where a single component stands.
 *
 * Distinct from authority, which is *who decided*. A component can be
 * `USER_SELECTED` in status and carry `USER_SELECTED` authority, but `REJECTED`
 * and `SUPERSEDED` are histories rather than authorities — a rejected
 * recommendation holds no authority over anything, and is kept so the record
 * shows what was offered and turned down.
 */
export const STACK_COMPONENT_STATUSES = [
  'NOT_DEFINED',
  'AI_RECOMMENDED',
  'USER_SELECTED',
  'USER_APPROVED',
  'LOCKED',
  'REJECTED',
  'SUPERSEDED',
] as const;

export type StackComponentStatus = (typeof STACK_COMPONENT_STATUSES)[number];
export const stackComponentStatusSchema = z.enum(STACK_COMPONENT_STATUSES);

export const STACK_COMPONENT_STATUS_LABELS: Readonly<Record<StackComponentStatus, string>> = {
  NOT_DEFINED: 'Not decided',
  AI_RECOMMENDED: 'Suggested',
  USER_SELECTED: 'Chosen by you',
  USER_APPROVED: 'Approved by you',
  LOCKED: 'Locked',
  REJECTED: 'Rejected',
  SUPERSEDED: 'Replaced',
};

/** The authority a component in each status carries. */
export const STATUS_AUTHORITY: Readonly<Record<StackComponentStatus, StackAuthorityLevel>> = {
  NOT_DEFINED: 'UNDEFINED',
  AI_RECOMMENDED: 'AI_RECOMMENDATION',
  USER_SELECTED: 'USER_SELECTED',
  USER_APPROVED: 'USER_APPROVED',
  LOCKED: 'LOCKED_USER_SELECTION',
  // A rejected or replaced component decides nothing. Kept for the record.
  REJECTED: 'UNDEFINED',
  SUPERSEDED: 'UNDEFINED',
};

export function authorityOf(status: StackComponentStatus): StackAuthorityLevel {
  return STATUS_AUTHORITY[status];
}

/**
 * Legal status changes.
 *
 * `LOCKED` leads only to `USER_APPROVED`, and only through the explicit unlock
 * action — there is no path that reaches a locked component by accident, from
 * a re-recommendation, a baseline change or a bulk operation.
 */
export const STACK_COMPONENT_TRANSITIONS: Readonly<
  Record<StackComponentStatus, readonly StackComponentStatus[]>
> = {
  NOT_DEFINED: ['AI_RECOMMENDED', 'USER_SELECTED'],
  AI_RECOMMENDED: ['USER_SELECTED', 'USER_APPROVED', 'REJECTED', 'SUPERSEDED', 'AI_RECOMMENDED'],
  USER_SELECTED: ['USER_APPROVED', 'USER_SELECTED', 'REJECTED', 'SUPERSEDED'],
  USER_APPROVED: ['LOCKED', 'USER_SELECTED', 'SUPERSEDED'],
  // Unlocking is the only way out, and it is a deliberate user action.
  LOCKED: ['USER_APPROVED'],
  REJECTED: ['USER_SELECTED', 'AI_RECOMMENDED'],
  SUPERSEDED: [],
};

export function canTransitionComponent(
  from: StackComponentStatus,
  to: StackComponentStatus,
): boolean {
  return STACK_COMPONENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses that count as a decision for approval purposes. */
export const DECIDED_COMPONENT_STATUSES: readonly StackComponentStatus[] = [
  'USER_SELECTED',
  'USER_APPROVED',
  'LOCKED',
];

export function isDecided(status: StackComponentStatus): boolean {
  return DECIDED_COMPONENT_STATUSES.includes(status);
}

/**
 * Whether the AI may replace a component in this status.
 *
 * `REJECTED` is deliberately true: the user turned a suggestion down, and a
 * later run over changed requirements is allowed to fill the empty slot again.
 * What it must not do is silently re-propose the same technology, which the
 * recommendation filter handles by carrying rejections forward as context.
 */
export function aiMayReplace(status: StackComponentStatus): boolean {
  return aiMayOccupy(authorityOf(status));
}

/* ------------------------------------------------------ where it came from */

/**
 * Why a user-selected technology is in the stack.
 *
 * A client mandate and a developer's preference are both authoritative and are
 * not the same fact. The first is a constraint the Statement of Work has to
 * state and the Client Dependency Sheet has to account for; the second is a
 * choice the team made and could revisit. Collapsing them would lose the
 * distinction exactly where later documents need it.
 */
export const SELECTION_SOURCES = ['USER', 'CLIENT_REQUIREMENT', 'EXISTING_INFRASTRUCTURE'] as const;

export type SelectionSource = (typeof SELECTION_SOURCES)[number];
export const selectionSourceSchema = z.enum(SELECTION_SOURCES);

export const SELECTION_SOURCE_LABELS: Readonly<Record<SelectionSource, string>> = {
  USER: 'Your preference',
  CLIENT_REQUIREMENT: 'The client requires it',
  EXISTING_INFRASTRUCTURE: 'Already in place',
};

export const SELECTION_SOURCE_DESCRIPTIONS: Readonly<Record<SelectionSource, string>> = {
  USER: 'Your team chose this. It can be revisited.',
  CLIENT_REQUIREMENT:
    'The requirements mandate it. It will appear as a constraint in the documents.',
  EXISTING_INFRASTRUCTURE:
    'The client already runs this. It will appear as a client-provided dependency.',
};

/** Sources that represent something outside the team's control to change. */
export const MANDATED_SOURCES: readonly SelectionSource[] = [
  'CLIENT_REQUIREMENT',
  'EXISTING_INFRASTRUCTURE',
];

export function isMandated(source: SelectionSource): boolean {
  return MANDATED_SOURCES.includes(source);
}

/* ------------------------------------------------------- selection modes */

/**
 * How the stack gets filled in.
 *
 * `USER_SELECTS_ALL` is not a convenience. It is the mode that has to work when
 * the inference server is down, the model will not load, or the operator has
 * simply not set one up — and if the stack step cannot be completed without a
 * model, the whole workflow inherits a dependency on one.
 */
export const STACK_SELECTION_MODES = ['AI_RECOMMENDS_ALL', 'USER_SELECTS_ALL', 'HYBRID'] as const;

export type StackSelectionMode = (typeof STACK_SELECTION_MODES)[number];
export const stackSelectionModeSchema = z.enum(STACK_SELECTION_MODES);

export const STACK_SELECTION_MODE_LABELS: Readonly<Record<StackSelectionMode, string>> = {
  AI_RECOMMENDS_ALL: 'Let the AI suggest everything',
  USER_SELECTS_ALL: 'Choose everything myself',
  HYBRID: 'I will choose some, the AI suggests the rest',
};

export const STACK_SELECTION_MODE_DESCRIPTIONS: Readonly<Record<StackSelectionMode, string>> = {
  AI_RECOMMENDS_ALL:
    'The AI suggests a technology for every category your project needs. You accept, reject or replace each one.',
  USER_SELECTS_ALL:
    'You pick every technology. No AI is used, so this works even when no inference server is running.',
  HYBRID:
    'Anything you have already chosen stays exactly as it is. The AI only suggests technologies for the categories still undecided.',
};

/** Whether this mode needs an inference provider at all. */
export function modeNeedsInference(mode: StackSelectionMode): boolean {
  return mode !== 'USER_SELECTS_ALL';
}
