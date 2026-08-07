/**
 * Why a Phase 4 request was refused, and what to tell the user about it.
 *
 * The same two rules as Phase 3. **A rejection must be actionable** — it names
 * the problem and, where there is one, the fix. **A rejection must not describe
 * our internals** — no model names, no prompt text, no library messages. The
 * real detail goes to the structured log under the request's correlation id.
 *
 * One rule is specific to this phase: a refusal about the *analysis* must never
 * imply the user did something wrong when the truth is that a small self-hosted
 * model could not do the job. "The model could not produce valid output" is an
 * honest sentence; "your documents could not be processed" is not.
 */

export const ANALYSIS_ERROR_CODES = {
  ANALYSIS_NOT_CONFIGURED: 'ANALYSIS_NOT_CONFIGURED',
  ANALYSIS_ALREADY_RUNNING: 'ANALYSIS_ALREADY_RUNNING',
  ANALYSIS_NOT_RUNNING: 'ANALYSIS_NOT_RUNNING',
  NO_REVIEWED_SOURCES: 'NO_REVIEWED_SOURCES',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  REQUIREMENT_NOT_FOUND: 'REQUIREMENT_NOT_FOUND',
  REQUIREMENT_SUPERSEDED: 'REQUIREMENT_SUPERSEDED',
  FINDING_NOT_FOUND: 'FINDING_NOT_FOUND',
  FINDING_ALREADY_RESOLVED: 'FINDING_ALREADY_RESOLVED',
  CLARIFICATION_NOT_FOUND: 'CLARIFICATION_NOT_FOUND',
  CLARIFICATION_ALREADY_ANSWERED: 'CLARIFICATION_ALREADY_ANSWERED',
  CLARIFICATION_NOT_ANSWERED: 'CLARIFICATION_NOT_ANSWERED',
  NO_PROPOSAL: 'NO_PROPOSAL',
  DISMISSAL_REFERENCE_REQUIRED: 'DISMISSAL_REFERENCE_REQUIRED',
  DISMISSAL_REFERENCE_INVALID: 'DISMISSAL_REFERENCE_INVALID',
  REQUIREMENT_STILL_PRESENT: 'REQUIREMENT_STILL_PRESENT',
  BASELINE_NOT_FOUND: 'BASELINE_NOT_FOUND',
  BASELINE_HAS_BLOCKERS: 'BASELINE_HAS_BLOCKERS',
  BASELINE_ALREADY_APPROVED: 'BASELINE_ALREADY_APPROVED',
  BASELINE_OUTDATED: 'BASELINE_OUTDATED',
  BASELINE_EMPTY: 'BASELINE_EMPTY',
  INVALID_PRIMARY_ITEM: 'INVALID_PRIMARY_ITEM',
  ITEM_LIMIT_REACHED: 'ITEM_LIMIT_REACHED',
} as const;

export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[keyof typeof ANALYSIS_ERROR_CODES];

export const ANALYSIS_ERROR_MESSAGES: Readonly<Record<AnalysisErrorCode, string>> = {
  ANALYSIS_NOT_CONFIGURED:
    'Requirement analysis is not switched on for this deployment. An inference server has to be configured before it can run.',
  ANALYSIS_ALREADY_RUNNING: 'An analysis is already running for this project.',
  ANALYSIS_NOT_RUNNING: 'There is no analysis running to cancel.',
  NO_REVIEWED_SOURCES:
    'There is nothing to analyse yet. Upload your documents and finish reviewing what was read from them.',
  RUN_NOT_FOUND: 'That analysis could not be found in this project.',
  REQUIREMENT_NOT_FOUND: 'That requirement could not be found in this project.',
  REQUIREMENT_SUPERSEDED:
    'That requirement was merged into another one and can no longer be edited.',
  FINDING_NOT_FOUND: 'That finding could not be found in this project.',
  FINDING_ALREADY_RESOLVED: 'Someone has already decided about this one.',
  CLARIFICATION_NOT_FOUND: 'That question could not be found in this project.',
  CLARIFICATION_ALREADY_ANSWERED:
    'That question has already been answered and applied. Answer it again to change it.',
  CLARIFICATION_NOT_ANSWERED: 'There is no answer to confirm yet.',
  NO_PROPOSAL: 'There is no proposed change waiting on this requirement.',
  DISMISSAL_REFERENCE_REQUIRED:
    'Say where the answer already is, or which requirement went. A blocking question is not dismissed on assertion alone.',
  DISMISSAL_REFERENCE_INVALID:
    'That reference could not be checked. Point at a document in this project, a question with a confirmed answer, or a requirement.',
  REQUIREMENT_STILL_PRESENT:
    'That requirement is still in the baseline, so the question about it still stands. Reject or merge it first.',
  BASELINE_NOT_FOUND: 'There is no requirement baseline for this project yet.',
  BASELINE_HAS_BLOCKERS:
    'This baseline cannot be approved yet. Work through the items listed above it first.',
  BASELINE_ALREADY_APPROVED: 'This baseline has already been approved.',
  BASELINE_OUTDATED:
    'Your documents have changed since this baseline was approved. Run the analysis again to produce a new version.',
  BASELINE_EMPTY: 'This baseline has no requirements in it, so there is nothing to approve.',
  INVALID_PRIMARY_ITEM: 'The requirement you chose to keep is not one of the duplicates.',
  ITEM_LIMIT_REACHED:
    'This project has reached the maximum number of requirements. Split it into smaller projects.',
};

export function analysisErrorMessage(code: AnalysisErrorCode): string {
  return ANALYSIS_ERROR_MESSAGES[code];
}
