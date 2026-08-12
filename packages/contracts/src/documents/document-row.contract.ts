import { z } from 'zod';

import { documentReferenceSchema } from './document-section.contract';

/**
 * A structured row in a document that is a list of things rather than prose.
 *
 * ## Why a generic row and not a field per document
 *
 * Feature Listing has `features`. If Acceptance Criteria added `criteria` and
 * Assumptions added `assumptions` and the Work Breakdown Structure added
 * `workPackages`, the engine would end up with a field, a storage collection, a
 * mapper branch and a set of endpoints per document — which is five copies of one
 * engine wearing a shared name.
 *
 * So there is one row envelope. The envelope carries what the *engine* needs:
 * identity, order, where the row came from, whether a person has edited it,
 * whether a rewrite is waiting for a decision, and what it cites. The `payload`
 * carries what the *document* needs, and is validated by that document's own
 * schema before anything is stored.
 *
 * Feature rows keep their own shape and their own collection. That is not an
 * inconsistency: a feature row carries authoritative hours copied from the
 * approved estimate, is reconciled against it on every read, and has an
 * eight-column export format pinned by contract. Those are real differences, and
 * flattening them into a generic payload would lose the checks that make Feature
 * Listing safe.
 *
 * ## Origin, and what a person wrote
 *
 * The same rule as sections, for the same reason. `GENERATED` rows may be
 * replaced by regeneration. A row a person edited or wrote may not — regeneration
 * produces a *proposal* beside it and stops, because replacing it would discard a
 * decision and the application cannot tell which words were the decision.
 *
 * `USER_DEFINED` is the third case and it means something stronger than edited: a
 * person added this row from nothing, so no upstream evidence produced it. Those
 * rows are marked as such wherever they are shown, and Phase 8's documents require
 * a reason before one can be approved — an acceptance criterion nobody can trace
 * is exactly the kind of thing that should have to be justified out loud.
 */

/** The kinds of row a document can be a list of. */
export const DOCUMENT_ROW_KINDS = [
  'ACCEPTANCE_CRITERION',
  'ASSUMPTION',
  /* Declared for the graph and the UI. Phase 9 implements these. */
  'WORK_PACKAGE',
  'CLIENT_DEPENDENCY',
] as const;

export type DocumentRowKind = (typeof DOCUMENT_ROW_KINDS)[number];
export const documentRowKindSchema = z.enum(DOCUMENT_ROW_KINDS);

export const ROW_ORIGINS = [
  /** Written by a generation run and untouched since. */
  'GENERATED',
  /** Generated, then edited by a person. Protected from silent replacement. */
  'USER_EDITED',
  /** Added by a person from nothing. Protected, and attributable. */
  'USER_DEFINED',
] as const;

export type RowOrigin = (typeof ROW_ORIGINS)[number];
export const rowOriginSchema = z.enum(ROW_ORIGINS);

export function isRowProtected(origin: RowOrigin): boolean {
  return origin === 'USER_EDITED' || origin === 'USER_DEFINED';
}

/** Whether regeneration may overwrite this row without asking. */
export function mayReplaceRowDirectly(origin: RowOrigin): boolean {
  return !isRowProtected(origin);
}

/**
 * The envelope. Everything here is the engine's business.
 *
 * `payload` is `unknown` at this level on purpose: the envelope must not know
 * what an acceptance criterion is. Each document's schema parses it, and nothing
 * reaches storage that has not been through one.
 */
export const documentRowSchema = z
  .object({
    rowId: z.string().min(1).max(64),
    kind: documentRowKindSchema,
    /** Position in the document. Stable across regeneration of other rows. */
    order: z.number().int().nonnegative(),
    origin: rowOriginSchema,
    /**
     * Why a person added this row, when they added it from nothing.
     *
     * Required before approval for a `USER_DEFINED` row — see
     * `rowNeedsAttribution`. A row with no upstream evidence and no stated reason
     * is an assertion nobody can check.
     */
    attribution: z.string().max(1_000).optional(),
    /** A suggested rewrite waiting for a decision. Never applied on its own. */
    proposed: z.unknown().optional(),
    proposedAt: z.string().datetime().optional(),
    /** What this row is built on. Verified to exist before storage. */
    references: z.array(documentReferenceSchema).max(40),
    /** Set when a person deliberately excluded this row from the document. */
    excludedReason: z.string().max(500).optional(),
    /** The document-specific content. Parsed by that document's schema. */
    payload: z.unknown(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type DocumentRow = z.infer<typeof documentRowSchema>;

/** Whether a proposed rewrite is waiting on this row. */
export function hasRowProposal(row: Pick<DocumentRow, 'proposed'>): boolean {
  return row.proposed !== undefined && row.proposed !== null;
}

/**
 * Whether this row cannot be approved until somebody says where it came from.
 *
 * A generated row is traceable by construction — it has references. A row a
 * person typed in has only their word for it, and asking for that word is the
 * difference between a document that can be defended and one that cannot.
 */
export function rowNeedsAttribution(
  row: Pick<DocumentRow, 'origin' | 'attribution' | 'references'>,
): boolean {
  return (
    row.origin === 'USER_DEFINED' &&
    row.references.length === 0 &&
    (row.attribution ?? '').trim().length === 0
  );
}

/** Rows still waiting for somebody to decide about a proposed rewrite. */
export function rowsAwaitingDecision(
  rows: readonly Pick<DocumentRow, 'rowId' | 'proposed'>[],
): readonly string[] {
  return rows.filter((row) => hasRowProposal(row)).map((row) => row.rowId);
}

/* --------------------------------------------------------- write shapes */

export const editRowSchema = z
  .object({
    /** The document-specific fields being changed. Parsed per document. */
    payload: z.unknown(),
    /** Requirement, feature or other citations to attach. Verified server-side. */
    referenceIds: z.array(z.string().max(64)).max(40).optional(),
    attribution: z.string().max(1_000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type EditRow = z.infer<typeof editRowSchema>;

export const addRowSchema = z
  .object({
    payload: z.unknown(),
    referenceIds: z.array(z.string().max(64)).max(40).optional(),
    /** Why this row exists, when nothing upstream produced it. */
    attribution: z.string().max(1_000),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AddRow = z.infer<typeof addRowSchema>;

/**
 * Taking a row out of the working document.
 *
 * The reason is required and kept in the audit trail, because "why did AC-014
 * disappear between v3 and v4?" is a question somebody asks months later, and the
 * diff alone cannot answer it.
 */
export const removeRowSchema = z
  .object({
    reason: z.string().min(1).max(500),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RemoveRow = z.infer<typeof removeRowSchema>;

export const excludeRowSchema = z
  .object({
    reason: z.string().min(1).max(500),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ExcludeRow = z.infer<typeof excludeRowSchema>;

export const regenerateRowSchema = z
  .object({
    /** What the user wants different. Optional; regeneration works without it. */
    instruction: z.string().max(2_000).optional(),
    useAi: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RegenerateRow = z.infer<typeof regenerateRowSchema>;

export const regenerateRowGroupSchema = z
  .object({
    /** A module for acceptance criteria, a category for assumptions. */
    group: z.string().min(1).max(200),
    instruction: z.string().max(2_000).optional(),
    useAi: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RegenerateRowGroup = z.infer<typeof regenerateRowGroupSchema>;

export const resolveRowProposalSchema = z
  .object({
    decision: z.enum(['KEEP_CURRENT', 'ACCEPT_GENERATED_REVISION', 'EDIT_GENERATED_REVISION']),
    /** Required for EDIT_GENERATED_REVISION: the version the person settled on. */
    payload: z.unknown().optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ResolveRowProposal = z.infer<typeof resolveRowProposalSchema>;
