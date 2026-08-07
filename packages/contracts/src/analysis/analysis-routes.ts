import { buildApiPath } from '../http/api-routes';

/**
 * Phase 4 endpoints.
 *
 * Every route hangs off `projects/current`, exactly as Phase 3's do. The project
 * comes from the verified session, so there is no request shape in which a
 * caller can name a project it has not authenticated for — and a requirement,
 * conflict or baseline id in a path therefore identifies a record *within the
 * caller's own project* and nothing else.
 */
export const ANALYSIS_ROUTES = {
  /** GET — every analysis run for the project, newest first. POST — start one. */
  runs: buildApiPath('projects/current/analysis/runs'),
  /** GET — the current run, its progress and its status. */
  currentRun: buildApiPath('projects/current/analysis/runs/current'),
  /** POST — ask the running analysis to stop. Checked between tasks. */
  cancelRun: (runId: string) => buildApiPath('projects/current/analysis/runs', runId, 'cancel'),
  /** GET — one run, including every task execution it performed. */
  run: (runId: string) => buildApiPath('projects/current/analysis/runs', runId),

  /** GET — the requirements in the current baseline. POST — add one by hand. */
  requirements: buildApiPath('projects/current/analysis/requirements'),
  /** GET / PATCH a single requirement. */
  requirement: (itemId: string) => buildApiPath('projects/current/analysis/requirements', itemId),
  /** GET — the evidence behind one requirement, with its cited block text. */
  requirementEvidence: (itemId: string) =>
    buildApiPath('projects/current/analysis/requirements', itemId, 'evidence'),

  /** GET — every finding, grouped by kind. */
  findings: buildApiPath('projects/current/analysis/findings'),
  /** POST — merge a duplicate group or keep it separate. */
  duplicate: (groupId: string) =>
    buildApiPath('projects/current/analysis/findings/duplicates', groupId),
  /** POST — resolve a conflict. Never resolved automatically. */
  conflict: (conflictId: string) =>
    buildApiPath('projects/current/analysis/findings/conflicts', conflictId),
  /** GET — what this conflict looked like before each change to it. */
  conflictHistory: (conflictId: string) =>
    buildApiPath('projects/current/analysis/findings/conflicts', conflictId, 'history'),
  /** POST — settle an ambiguity finding. */
  ambiguity: (findingId: string) =>
    buildApiPath('projects/current/analysis/findings/ambiguities', findingId),
  /** POST — settle a missing-information finding. */
  gap: (findingId: string) => buildApiPath('projects/current/analysis/findings/gaps', findingId),

  /** GET — every clarification question. */
  clarifications: buildApiPath('projects/current/analysis/clarifications'),
  /** POST — answer one. */
  answerClarification: (clarificationId: string) =>
    buildApiPath('projects/current/analysis/clarifications', clarificationId, 'answer'),
  /** POST — confirm the answer, which folds it into the requirements. */
  confirmClarification: (clarificationId: string) =>
    buildApiPath('projects/current/analysis/clarifications', clarificationId, 'confirm'),
  /** POST — dismiss one, with a reason. */
  dismissClarification: (clarificationId: string) =>
    buildApiPath('projects/current/analysis/clarifications', clarificationId, 'dismiss'),

  /** GET — every requirement with a revision waiting for a decision. */
  proposals: buildApiPath('projects/current/analysis/proposals'),
  /** POST — accept, reject or rewrite a proposed revision. */
  proposal: (itemId: string) =>
    buildApiPath('projects/current/analysis/requirements', itemId, 'proposal'),
  /** GET — one requirement's version history. */
  requirementHistory: (itemId: string) =>
    buildApiPath('projects/current/analysis/requirements', itemId, 'history'),

  /** GET — the current baseline, with coverage, alignment and blockers. */
  baseline: buildApiPath('projects/current/analysis/baseline'),
  /** GET — every version, so an approved one stays readable. */
  baselineVersions: buildApiPath('projects/current/analysis/baseline/versions'),
  /** GET — one version. */
  baselineVersion: (version: number) =>
    buildApiPath('projects/current/analysis/baseline/versions', String(version)),
  /** POST — approve the current baseline. Refused while blockers remain. */
  approveBaseline: buildApiPath('projects/current/analysis/baseline/approve'),
  /** POST — move a draft baseline into review. */
  reviewBaseline: buildApiPath('projects/current/analysis/baseline/review'),
} as const;

/** Template forms, for OpenAPI and for the controller decorators. */
export const ANALYSIS_ROUTE_TEMPLATES = {
  runs: ANALYSIS_ROUTES.runs,
  currentRun: ANALYSIS_ROUTES.currentRun,
  run: ANALYSIS_ROUTES.run(':runId'),
  cancelRun: ANALYSIS_ROUTES.cancelRun(':runId'),
  requirements: ANALYSIS_ROUTES.requirements,
  requirement: ANALYSIS_ROUTES.requirement(':itemId'),
  requirementEvidence: ANALYSIS_ROUTES.requirementEvidence(':itemId'),
  findings: ANALYSIS_ROUTES.findings,
  duplicate: ANALYSIS_ROUTES.duplicate(':groupId'),
  conflict: ANALYSIS_ROUTES.conflict(':conflictId'),
  conflictHistory: ANALYSIS_ROUTES.conflictHistory(':conflictId'),
  ambiguity: ANALYSIS_ROUTES.ambiguity(':findingId'),
  gap: ANALYSIS_ROUTES.gap(':findingId'),
  clarifications: ANALYSIS_ROUTES.clarifications,
  answerClarification: ANALYSIS_ROUTES.answerClarification(':clarificationId'),
  confirmClarification: ANALYSIS_ROUTES.confirmClarification(':clarificationId'),
  proposals: ANALYSIS_ROUTES.proposals,
  proposal: ANALYSIS_ROUTES.proposal(':itemId'),
  requirementHistory: ANALYSIS_ROUTES.requirementHistory(':itemId'),
  dismissClarification: ANALYSIS_ROUTES.dismissClarification(':clarificationId'),
  baseline: ANALYSIS_ROUTES.baseline,
  baselineVersions: ANALYSIS_ROUTES.baselineVersions,
  baselineVersion: ANALYSIS_ROUTES.baselineVersion(-1).replace('-1', ':version'),
  approveBaseline: ANALYSIS_ROUTES.approveBaseline,
  reviewBaseline: ANALYSIS_ROUTES.reviewBaseline,
} as const;
