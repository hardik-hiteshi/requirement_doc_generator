/**
 * Why a Phase 5 request was refused, and what to tell the user about it.
 *
 * The same two rules as Phases 3 and 4. **A rejection must be actionable** — it
 * names the problem and, where there is one, the fix. **A rejection must not
 * describe our internals** — no model names, no prompt text, no library
 * messages; that detail goes to the structured log under the correlation id.
 *
 * One rule belongs to this phase. A refusal must never read as though the
 * application overruled the user. `STACK_LOCKED` and `COMPONENT_LOCKED` are
 * refusals *in the user's favour* — they exist because something is sealed and
 * a request would have quietly changed it — and the wording says so.
 */

export const STACK_ERROR_CODES = {
  BASELINE_NOT_APPROVED: 'BASELINE_NOT_APPROVED',
  BASELINE_NOT_CURRENT: 'BASELINE_NOT_CURRENT',
  PROJECT_TYPE_UNCONFIRMED: 'PROJECT_TYPE_UNCONFIRMED',
  STACK_NOT_FOUND: 'STACK_NOT_FOUND',
  STACK_LOCKED: 'STACK_LOCKED',
  STACK_NOT_LOCKED: 'STACK_NOT_LOCKED',
  STACK_NOT_APPROVED: 'STACK_NOT_APPROVED',
  STACK_ALREADY_APPROVED: 'STACK_ALREADY_APPROVED',
  STACK_HAS_BLOCKERS: 'STACK_HAS_BLOCKERS',
  STACK_OUTDATED: 'STACK_OUTDATED',
  COMPONENT_NOT_FOUND: 'COMPONENT_NOT_FOUND',
  COMPONENT_LOCKED: 'COMPONENT_LOCKED',
  COMPONENT_NOT_RECOMMENDED: 'COMPONENT_NOT_RECOMMENDED',
  CATEGORY_NOT_APPLICABLE: 'CATEGORY_NOT_APPLICABLE',
  CATEGORY_ALREADY_FILLED: 'CATEGORY_ALREADY_FILLED',
  UNKNOWN_TECHNOLOGY: 'UNKNOWN_TECHNOLOGY',
  TECHNOLOGY_WRONG_CATEGORY: 'TECHNOLOGY_WRONG_CATEGORY',
  UNKNOWN_REQUIREMENT: 'UNKNOWN_REQUIREMENT',
  RECOMMENDATION_NOT_CONFIGURED: 'RECOMMENDATION_NOT_CONFIGURED',
  RECOMMENDATION_ALREADY_RUNNING: 'RECOMMENDATION_ALREADY_RUNNING',
  RECOMMENDATION_FAILED: 'RECOMMENDATION_FAILED',
  NOTHING_TO_RECOMMEND: 'NOTHING_TO_RECOMMEND',
  FINDING_NOT_FOUND: 'FINDING_NOT_FOUND',
  FINDING_NOT_ACKNOWLEDGEABLE: 'FINDING_NOT_ACKNOWLEDGEABLE',
  COMPONENT_LIMIT_REACHED: 'COMPONENT_LIMIT_REACHED',
} as const;

export type StackErrorCode = (typeof STACK_ERROR_CODES)[keyof typeof STACK_ERROR_CODES];

export const STACK_ERROR_MESSAGES: Readonly<Record<StackErrorCode, string>> = {
  BASELINE_NOT_APPROVED:
    'Approve your requirement baseline first. The technology decisions are made against approved requirements, not draft ones.',
  BASELINE_NOT_CURRENT:
    'The requirements have moved on since this stack was set. Review the stack against the current baseline before approving it.',
  PROJECT_TYPE_UNCONFIRMED:
    'Confirm what kind of project this is first. Which technologies even apply depends on it, and it will not be guessed.',
  STACK_NOT_FOUND: 'There is no technology stack for this project yet.',
  STACK_LOCKED:
    'The stack is locked, so nothing changed. Unlock it if you want to make changes — later phases build on the locked version, so reopening it is deliberate.',
  STACK_NOT_LOCKED:
    'The stack has not been locked yet. Later phases build on the locked stack, so nothing can be estimated or written until it is.',
  STACK_NOT_APPROVED: 'Approve the stack before locking it.',
  STACK_ALREADY_APPROVED: 'This stack has already been approved.',
  STACK_HAS_BLOCKERS: 'Some things still need your decision before this stack can be approved.',
  STACK_OUTDATED:
    'This stack is out of date because the requirements changed. Review it before approving.',
  COMPONENT_NOT_FOUND: 'That technology is not part of this project’s stack.',
  COMPONENT_LOCKED:
    'That technology is locked, so nothing changed. Unlock it first if you meant to change it.',
  COMPONENT_NOT_RECOMMENDED:
    'That is your own choice rather than a suggestion, so there is nothing to accept or reject. Change it directly instead.',
  CATEGORY_NOT_APPLICABLE:
    'Projects of this kind do not have that. If yours does, change the project type — the categories follow from it.',
  CATEGORY_ALREADY_FILLED:
    'Something is already chosen there, and a project has one of these. Replace what is there, or remove it first.',
  UNKNOWN_TECHNOLOGY:
    'That technology is not one this application holds reviewed facts about. You can still use it — enter it as your own choice and it will be recorded exactly as you typed it.',
  TECHNOLOGY_WRONG_CATEGORY: 'That technology does not do the job that category is for.',
  UNKNOWN_REQUIREMENT: 'One of the requirements cited is not in your approved baseline.',
  RECOMMENDATION_NOT_CONFIGURED:
    'AI suggestions are not switched on for this deployment. You can still choose the whole stack yourself, approve it and carry on.',
  RECOMMENDATION_ALREADY_RUNNING: 'Suggestions are already being prepared for this project.',
  RECOMMENDATION_FAILED:
    'The suggestions could not be prepared. Nothing in your stack was changed — you can retry, or choose the remaining technologies yourself.',
  NOTHING_TO_RECOMMEND:
    'Every category this project needs already has a decision, so there is nothing to suggest.',
  FINDING_NOT_FOUND:
    'That warning is no longer present — it may have cleared when something changed.',
  FINDING_NOT_ACKNOWLEDGEABLE:
    'That one cannot be acknowledged away. It is a direct contradiction with an approved requirement, so it has to be resolved.',
  COMPONENT_LIMIT_REACHED: 'This stack already holds as many technologies as one project can have.',
};

/** Limits, so a single project cannot become unbounded. */
export const STACK_LIMITS = {
  maxComponents: 80,
  maxVersions: 100,
  maxDecisions: 400,
  maxCustomNameLength: 120,
  maxNotesLength: 2000,
} as const;
