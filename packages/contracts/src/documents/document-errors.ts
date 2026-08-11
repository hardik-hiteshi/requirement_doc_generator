/**
 * Why a Phase 7 request was refused, and what to tell the user.
 *
 * The same two rules as every phase before it. **A rejection must be
 * actionable** — it names the problem and the fix. **A rejection must not
 * describe our internals** — that detail goes to the structured log under the
 * correlation id.
 *
 * One rule belongs to this phase. `EFFORT_NOT_EDITABLE_HERE` must never read as
 * a refusal to let the user change a number. They can change it; the message
 * says where, and why it matters that the change is recorded there.
 */

export const DOCUMENT_ERROR_CODES = {
  DOCUMENT_NOT_IMPLEMENTED: 'DOCUMENT_NOT_IMPLEMENTED',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  DOCUMENT_LOCKED: 'DOCUMENT_LOCKED',
  DOCUMENT_ALREADY_APPROVED: 'DOCUMENT_ALREADY_APPROVED',
  DOCUMENT_NOT_APPROVED: 'DOCUMENT_NOT_APPROVED',
  DOCUMENT_FINAL: 'DOCUMENT_FINAL',
  DOCUMENT_HAS_BLOCKERS: 'DOCUMENT_HAS_BLOCKERS',
  DOCUMENT_NOT_VALIDATED: 'DOCUMENT_NOT_VALIDATED',
  DOCUMENT_GENERATING: 'DOCUMENT_GENERATING',
  DOCUMENT_GENERATION_FAILED: 'DOCUMENT_GENERATION_FAILED',
  DOCUMENT_NOT_GENERATED: 'DOCUMENT_NOT_GENERATED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  SECTION_NOT_FOUND: 'SECTION_NOT_FOUND',
  NO_PROPOSAL_TO_RESOLVE: 'NO_PROPOSAL_TO_RESOLVE',
  FEATURE_NOT_FOUND: 'FEATURE_NOT_FOUND',
  EFFORT_NOT_EDITABLE_HERE: 'EFFORT_NOT_EDITABLE_HERE',
  UNKNOWN_REQUIREMENT: 'UNKNOWN_REQUIREMENT',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  WRONG_DOCUMENT_SHAPE: 'WRONG_DOCUMENT_SHAPE',
  NO_FINDING_TO_ACKNOWLEDGE: 'NO_FINDING_TO_ACKNOWLEDGE',
  DOCUMENT_GENERATION_NOT_CONFIGURED: 'DOCUMENT_GENERATION_NOT_CONFIGURED',
  DOCUMENT_UPSTREAM_STALE: 'DOCUMENT_UPSTREAM_STALE',
  MODULE_NOT_FOUND: 'MODULE_NOT_FOUND',
  NO_FEATURE_PROPOSAL: 'NO_FEATURE_PROPOSAL',
  /* Phase 8 — the structured row documents. */
  ROW_NOT_FOUND: 'ROW_NOT_FOUND',
  NO_ROW_PROPOSAL: 'NO_ROW_PROPOSAL',
  UNKNOWN_FEATURE: 'UNKNOWN_FEATURE',
  ATTRIBUTION_REQUIRED: 'ATTRIBUTION_REQUIRED',
  ASSUMPTION_NOT_CONFIRMABLE: 'ASSUMPTION_NOT_CONFIRMABLE',
  ASSUMPTION_PROVENANCE_REQUIRED: 'ASSUMPTION_PROVENANCE_REQUIRED',
  SECTION_NOT_MODEL_WRITABLE: 'SECTION_NOT_MODEL_WRITABLE',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  /* Phase 9 — the work breakdown and the client dependency sheet. */
  SCHEDULE_NOT_EDITABLE_HERE: 'SCHEDULE_NOT_EDITABLE_HERE',
  CREDENTIAL_VALUE_REFUSED: 'CREDENTIAL_VALUE_REFUSED',
  DEPENDENCY_TRANSITION_INVALID: 'DEPENDENCY_TRANSITION_INVALID',
  DEPENDENCY_VALIDATION_NOTE_REQUIRED: 'DEPENDENCY_VALIDATION_NOTE_REQUIRED',
  DEPENDENCY_STATUS_NOT_EDITABLE_HERE: 'DEPENDENCY_STATUS_NOT_EDITABLE_HERE',
  WBS_PARENT_NOT_FOUND: 'WBS_PARENT_NOT_FOUND',
} as const;

export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[keyof typeof DOCUMENT_ERROR_CODES];

export const DOCUMENT_ERROR_MESSAGES: Readonly<Record<DocumentErrorCode, string>> = {
  DOCUMENT_NOT_IMPLEMENTED:
    'That document is not available yet. The ones that are appear in the list, and the rest are marked unavailable rather than hidden.',
  DOCUMENT_NOT_FOUND: 'There is no document of that kind for this project yet.',
  DOCUMENT_LOCKED:
    'This document is not unlocked yet. The step above it has to be approved first — it is what this one is built on.',
  DOCUMENT_ALREADY_APPROVED:
    'This document is already approved. Reopen it if you want to change something; anything built on it will be marked out of date.',
  DOCUMENT_NOT_APPROVED: 'This document is not approved, so there is nothing to reopen.',
  DOCUMENT_FINAL:
    'This document has been issued, so it cannot be changed. Reopening is not the answer either — issue a new version instead.',
  DOCUMENT_HAS_BLOCKERS:
    'Some things still need your attention before this document can be approved.',
  DOCUMENT_NOT_VALIDATED:
    'Run validation first. Approving without it would mean approving something nobody checked.',
  DOCUMENT_GENERATING: 'This document is being written. One run at a time.',
  DOCUMENT_GENERATION_FAILED:
    'Writing this document did not finish. Nothing was changed, and you can try again.',
  DOCUMENT_NOT_GENERATED: 'This document has no content yet.',
  INVALID_STATUS_TRANSITION: 'That is not something this document can do from where it is.',
  SECTION_NOT_FOUND: 'That section is not part of this document.',
  NO_PROPOSAL_TO_RESOLVE: 'That section has no suggested rewrite waiting.',
  FEATURE_NOT_FOUND: 'That feature is not part of this document.',
  EFFORT_NOT_EDITABLE_HERE:
    'Hours come from the estimate you approved, so they are changed there rather than here. Open the estimation step, override the figure, and re-approve — that way the change is on the record and every document agrees.',
  UNKNOWN_REQUIREMENT: 'One of the requirements cited is not in your approved baseline.',
  VERSION_NOT_FOUND: 'There is no version of this document with that number.',
  WRONG_DOCUMENT_SHAPE: 'That operation does not apply to this kind of document.',
  NO_FINDING_TO_ACKNOWLEDGE: 'There is no warning of that kind to acknowledge.',
  DOCUMENT_GENERATION_NOT_CONFIGURED:
    'AI document writing is not switched on for this deployment. You can still write and edit every section yourself, validate it and approve it.',
  DOCUMENT_UPSTREAM_STALE:
    'Something this document is built on has changed since it was written, so it cannot be approved or issued as it stands. Read what changed, then regenerate or edit it — nothing has been altered for you.',
  ROW_NOT_FOUND: 'That entry is not part of this document.',
  NO_ROW_PROPOSAL: 'There is no suggested rewrite waiting on that entry.',
  UNKNOWN_FEATURE:
    'That feature is not in the approved Feature Listing. An acceptance criterion can only be about scope somebody has agreed to.',
  ATTRIBUTION_REQUIRED:
    'This entry was added by hand and nothing upstream supports it, so it needs a note saying where it came from before the document can be approved.',
  ASSUMPTION_NOT_CONFIRMABLE:
    'That assumption cannot be confirmed from its current state. A rejected assumption has to be reopened first.',
  ASSUMPTION_PROVENANCE_REQUIRED:
    'Confirming an assumption means saying what it rests on — the client said it, you are stating it, or a clarification settled it.',
  SECTION_NOT_MODEL_WRITABLE:
    'This section is written from the approved technology, timeline, milestones or assumptions, so it is not rewritten with AI. Change the approved source and regenerate.',
  CATEGORY_NOT_FOUND: 'No entries in this document belong to that category.',
  MODULE_NOT_FOUND: 'No features in this document belong to that module.',
  NO_FEATURE_PROPOSAL: 'That feature has no suggested rewrite waiting.',
  /*
   * Like `EFFORT_NOT_EDITABLE_HERE`, this must not read as a refusal to change the
   * plan. It can be changed — the message says where, and why doing it there keeps
   * the breakdown and the approved schedule agreeing with each other.
   */
  SCHEDULE_NOT_EDITABLE_HERE:
    'Start days, durations and the critical path come from the schedule you approved during estimation, so they are changed there rather than here. Adjust the estimate or its dependencies, re-approve, then regenerate this breakdown — that way one plan stays the plan.',
  CREDENTIAL_VALUE_REFUSED:
    'That looks like an actual credential. This sheet records that a credential is needed, requested, received and checked — never the value itself, because a document version cannot be unsent once it is issued. Describe what is needed instead, and send the secret through your own secret manager.',
  DEPENDENCY_TRANSITION_INVALID:
    'That is not a move this item can make from where it is. Something received has to be checked before it counts as accepted.',
  DEPENDENCY_VALIDATION_NOTE_REQUIRED:
    'Say what you checked and what it showed. Accepting or rejecting something without a note leaves no record of why the project was unblocked.',
  DEPENDENCY_STATUS_NOT_EDITABLE_HERE:
    'Whether something has been requested, received or accepted is recorded through the actions on the row, so the dates and the decision are captured together rather than typed in.',
  WBS_PARENT_NOT_FOUND:
    'That parent is not part of this breakdown, so there is nothing to add the work under.',
};
