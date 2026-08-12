import { buildApiPath } from '../http/api-routes';

/**
 * Phase 7 endpoints.
 *
 * One set of routes for every document type, with the type in the path. Seven
 * documents cannot mean seven controllers — the engine is shared, so the API is
 * too, and adding Acceptance Criteria later adds no endpoint at all.
 *
 * Everything hangs off `projects/current`, as every phase since Phase 3 does. The
 * project comes from the verified session, so a document type or a section id in
 * a path identifies a record inside the caller's own project, and there is no
 * request shape in which one project can name another's document.
 */
export const DOCUMENT_ROUTES = {
  /** GET — every document's state, locked or not. The step's landing view. */
  documents: buildApiPath('projects/current/documents'),

  /** GET — one document with its content, validation and blockers. */
  document: (type: string) => buildApiPath('projects/current/documents', type),

  /** POST — generate or regenerate the whole document. */
  generate: (type: string) => buildApiPath('projects/current/documents', type, 'generate'),

  /** GET — every version, newest first. */
  versions: (type: string) => buildApiPath('projects/current/documents', type, 'versions'),
  /** GET — one earlier version, exactly as it stood. */
  version: (type: string, version: string) =>
    buildApiPath('projects/current/documents', type, 'versions', version),
  /** GET — what changed between two versions. */
  compare: (type: string) => buildApiPath('projects/current/documents', type, 'compare'),
  /** POST — bring an earlier version back as the current content. */
  restore: (type: string) => buildApiPath('projects/current/documents', type, 'restore'),

  /** PUT — edit one section's text. */
  section: (type: string, sectionId: string) =>
    buildApiPath('projects/current/documents', type, 'sections', sectionId),
  /** POST — rewrite one section, optionally with a correction instruction. */
  regenerateSection: (type: string, sectionId: string) =>
    buildApiPath('projects/current/documents', type, 'sections', sectionId, 'regenerate'),
  /** POST — decide what happens to a proposed rewrite of a protected section. */
  resolveProposal: (type: string, sectionId: string) =>
    buildApiPath('projects/current/documents', type, 'sections', sectionId, 'proposal'),

  /** POST — a correction instruction: what to change, and where. */
  corrections: (type: string) => buildApiPath('projects/current/documents', type, 'corrections'),

  /** POST — rewrite one feature row's wording. Effort is never touched. */
  regenerateFeature: (type: string, featureId: string) =>
    buildApiPath('projects/current/documents', type, 'features', featureId, 'regenerate'),
  /** POST — rewrite every row in one module, and nothing else. */
  regenerateModule: (type: string) =>
    buildApiPath('projects/current/documents', type, 'features/regenerate-module'),
  /** POST — decide what happens to a row's suggested rewrite. */
  resolveFeatureProposal: (type: string, featureId: string) =>
    buildApiPath('projects/current/documents', type, 'features', featureId, 'proposal'),

  /** GET — the feature rows, for a table view. */
  features: (type: string) => buildApiPath('projects/current/documents', type, 'features'),
  /** PATCH — edit a row's descriptive fields. Effort is not one of them. */
  feature: (type: string, featureId: string) =>
    buildApiPath('projects/current/documents', type, 'features', featureId),
  /** POST — record that a requirement is deliberately not in the feature list. */
  excludeRequirement: (type: string) =>
    buildApiPath('projects/current/documents', type, 'exclusions'),
  /** GET — the strict eight-column CSV, exactly as it would be exported. */
  csv: (type: string) => buildApiPath('projects/current/documents', type, 'csv'),

  /** POST — run validation and store the result. */
  validate: (type: string) => buildApiPath('projects/current/documents', type, 'validate'),
  /** POST — record that a warning has been read and accepted. */
  acknowledgeFinding: (type: string) =>
    buildApiPath('projects/current/documents', type, 'validation/acknowledge'),

  /** POST — approve. Unlocks whatever depends on this document. */
  approve: (type: string) => buildApiPath('projects/current/documents', type, 'approve'),
  /** POST — withdraw approval. Dependent documents go out of date. */
  reopen: (type: string) => buildApiPath('projects/current/documents', type, 'reopen'),
  /** POST — mark issued. The issued version is immutable from then on. */
  markFinal: (type: string) => buildApiPath('projects/current/documents', type, 'final'),
  /**
   * POST — start a new working version from an issued document.
   *
   * The issued version is not touched. This is what "reopening" means once a
   * document has left the building: a new version to work on, beside the record of
   * what was sent.
   */
  revise: (type: string) => buildApiPath('projects/current/documents', type, 'revise'),

  /* ----------------------------------------- Phase 8: structured rows */

  /**
   * GET — the structured rows of a document that is a list.
   *
   * One set of row endpoints for acceptance criteria, assumptions and whatever
   * Phase 9 adds: the row kind comes from the document type, so a third list
   * document needs no new route.
   */
  rows: (type: string) => buildApiPath('projects/current/documents', type, 'rows'),
  /** POST — add a row by hand. Requires a note saying where it came from. */
  addRow: (type: string) => buildApiPath('projects/current/documents', type, 'rows'),
  /** PATCH — edit one row's own fields. */
  row: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId),
  /** POST — rewrite one row, optionally with a correction instruction. */
  regenerateRow: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'regenerate'),
  /** POST — rewrite every row in one group (a module, or a category). */
  regenerateRowGroup: (type: string) =>
    buildApiPath('projects/current/documents', type, 'rows/regenerate-group'),
  /** POST — decide what happens to a row's suggested rewrite. */
  resolveRowProposal: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'proposal'),
  /** POST — record that a row is deliberately left out, with a reason. */
  excludeRow: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'exclude'),
  /**
   * DELETE — take a row out of the working document.
   *
   * Different from excluding it. An exclusion is a decision that stays on the sheet
   * with its reason, which is what a client should see for scope deliberately left
   * out. A removal is for a row that should never have been there — a duplicate, or
   * something a reviewer added by mistake — and it disappears from the working
   * document while remaining in every version that had it.
   */
  removeRow: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId),

  /* ------------------------------------------ Phase 8: assumptions */

  /** POST — stand behind an assumption. Only a person may do this. */
  confirmAssumption: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'confirm'),
  /** POST — turn one down, with a reason. Kept on the record. */
  rejectAssumption: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'reject'),
  /** POST — record that a confirmed assumption turned out true, or did not. */
  settleAssumption: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'settle'),
  /** POST — ask a model for assumption candidates. Candidates only. */
  assumptionCandidates: (type: string) =>
    buildApiPath('projects/current/documents', type, 'rows/candidates'),

  /* ---------------------------------- Phase 9: client dependencies */

  /**
   * The dependency lifecycle, as three actions rather than a status field.
   *
   * Each records *when* alongside *what*, which a writable status could not: a sheet
   * whose whole job is tracking what arrived and when needs the timestamp captured by
   * the act, not typed in afterwards. `validate` is separate from `receive` for the
   * reason the whole status model exists — something that turned up is not something
   * that works.
   */

  /** POST — record that this has been asked for. */
  requestDependency: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'request'),
  /** POST — record that it arrived, in full or in part. Not that it is usable. */
  receiveDependency: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'receive'),
  /** POST — record what checking it showed: accepted, or rejected with a reason. */
  validateDependency: (type: string, rowId: string) =>
    buildApiPath('projects/current/documents', type, 'rows', rowId, 'validate'),

  /**
   * GET — every approved requirement, followed through every document.
   *
   * One request rather than per-document calls: the interesting output is the *gaps*,
   * and a gap is only visible when every document has been read together.
   */
  traceability: buildApiPath('projects/current/documents/traceability'),

  /** GET — the current or most recent generation run. */
  currentRun: (type: string) => buildApiPath('projects/current/documents', type, 'run/current'),
} as const;
