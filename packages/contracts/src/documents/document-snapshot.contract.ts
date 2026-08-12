import { z } from 'zod';

import { documentCurrentnessSchema, documentStatusSchema } from './document-status.contract';
import { documentTypeSchema } from './document-type.contract';
import { documentSectionSchema } from './document-section.contract';
import { documentValidationSchema } from './document-validation.contract';
import { documentOutdatedReasonSchema } from './document-dependency';
import { documentRowSchema } from './document-row.contract';
import { criteriaCoverageSchema } from './acceptance-criteria.contract';
import { assumptionSummarySchema } from './assumptions.contract';
import { dependencySummarySchema } from './client-dependency.contract';
import {
  reverseDependencyIndexSchema,
  wbsCoverageSchema,
  wbsReconciliationSchema,
} from './work-breakdown.contract';
import { sowScopeReconciliationSchema } from './statement-of-work.contract';
import {
  featureCoverageSchema,
  effortReconciliationSchema,
  featureRowSchema,
} from './feature-listing.contract';

/**
 * A document as it stands, with everything a reader needs to judge it.
 *
 * One shape for every document type. A `SECTIONS` document fills `sections`; a
 * `ROWS` document fills `features`. Two shapes would mean two engines, two
 * repositories and two of every endpoint — and Phase 7 exists partly to stop
 * that happening five more times.
 *
 * The upstream versions are stored, not looked up. That is what makes "this
 * document was written against baseline v3" answerable a month later, when the
 * baseline is at v7 — and it is the input to outdated propagation.
 */

export const DOCUMENT_SCHEMA_VERSION = 1;

export const documentBlockerKinds = [
  'not_generated',
  'blocking_validation',
  'unresolved_proposal',
  'outdated_inputs',
  'prerequisite_not_approved',
  'coverage_incomplete',
  'effort_mismatch',
  'empty_required_section',
  /* Phase 8 */
  /** A row somebody added by hand with nothing saying where it came from. */
  'attribution_missing',
  /** Model-suggested assumptions nobody has accepted or turned down. */
  'unconfirmed_assumptions',
  /** A confirmed assumption whose failure would stop the plan. */
  'blocking_assumption',
  /** The SOW's scope does not reconcile with the approved Feature Listing. */
  'scope_not_reconciled',
  /* Phase 9 */
  /**
   * The work breakdown does not add up to the approved estimate.
   *
   * Separate from `effort_mismatch`, which is a document quoting an older set of
   * hours. This is a breakdown whose own parts do not sum to the plan they came
   * from — per role, not merely in total, because two roles can offset each other
   * and leave a believable grand total.
   */
  'wbs_not_reconciled',
] as const;

export type DocumentBlockerKind = (typeof documentBlockerKinds)[number];

export const documentBlockerSchema = z
  .object({
    kind: z.enum(documentBlockerKinds),
    count: z.number().int().positive(),
    summary: z.string().min(1).max(300),
    action: z.string().min(1).max(300),
    subjectIds: z.array(z.string().max(64)).max(200),
  })
  .strict();

export type DocumentBlocker = z.infer<typeof documentBlockerSchema>;

/** Who or what produced the current content. */
export const generatorMetadataSchema = z
  .object({
    /** `deterministic`, `ollama`, `vllm` — never a vendor account. */
    provider: z.string().max(60),
    model: z.string().max(120),
    /** Prompt versions used, by task id. */
    promptVersions: z.record(z.string().max(60), z.string().max(20)),
    /** True when the content was assembled without a model. */
    deterministicOnly: z.boolean(),
  })
  .strict();

export type GeneratorMetadata = z.infer<typeof generatorMetadataSchema>;

export const documentSnapshotSchema = z
  .object({
    documentId: z.string().min(1).max(64),
    type: documentTypeSchema,
    projectId: z.string().min(1).max(64),
    /** Monotonic per project and type. */
    version: z.number().int().positive(),
    status: documentStatusSchema,
    /**
     * Whether this content still matches the project.
     *
     * Derived on every read from the upstream versions below, never stored as
     * truth. `FINAL` + `OUTDATED` is a legitimate and important combination: the
     * immutable version that was issued, and the fact that the project has moved
     * since. `outdatedReasons` says what moved.
     */
    currentness: documentCurrentnessSchema,
    title: z.string().min(1).max(300),

    /* Upstream authority, as it stood when this content was written. */
    baselineId: z.string().max(64).optional(),
    baselineVersion: z.number().int().nonnegative().optional(),
    stackSnapshotId: z.string().max(64).optional(),
    stackVersion: z.number().int().nonnegative().optional(),
    estimateSnapshotId: z.string().max(64).optional(),
    estimateVersion: z.number().int().nonnegative().optional(),
    /**
     * Version of each prerequisite document this was built on.
     *
     * Keyed loosely rather than as a full record over the type enum: a document
     * has one or two prerequisites, not seven, and requiring all seven keys would
     * mean writing zeros for documents that do not exist.
     */
    prerequisiteVersions: z.record(z.string().max(60), z.number().int().nonnegative()),

    /*
     * Content. A document fills the channel its shape calls for: prose documents
     * fill `sections`, Feature Listing fills `features`, and every other list
     * document fills `rows`.
     *
     * Three channels rather than one because features are genuinely different —
     * they carry authoritative hours reconciled against the approved estimate —
     * and rather than five, because everything after Feature Listing shares one
     * envelope. See `document-row.contract.ts`.
     */
    sections: z.array(documentSectionSchema).max(60),
    features: z.array(featureRowSchema).max(2_000),
    rows: z.array(documentRowSchema).max(2_000),

    /* Assessment. */
    validation: documentValidationSchema.nullable(),
    blockers: z.array(documentBlockerSchema).max(30),
    outdatedReasons: z.array(documentOutdatedReasonSchema).max(20),
    coverage: featureCoverageSchema.nullable(),
    reconciliation: effortReconciliationSchema.nullable(),
    /* Per-document assessments, present only for the document they belong to. */
    criteriaCoverage: criteriaCoverageSchema.nullable(),
    assumptionSummary: assumptionSummarySchema.nullable(),
    scopeReconciliation: sowScopeReconciliationSchema.nullable(),
    /** Whether the breakdown adds up to the approved estimate, role by role. */
    wbsReconciliation: wbsReconciliationSchema.nullable(),
    wbsCoverage: wbsCoverageSchema.nullable(),
    /** What is outstanding on the dependency sheet, and what of it blocks work. */
    dependencySummary: dependencySummarySchema.nullable(),
    /**
     * Client dependencies that name each work package, derived on read.
     *
     * Present on the work breakdown only, and null until a dependency sheet exists. Not
     * stored content: the sheet owns the relationship, and this is it read backwards so
     * a reader on a task can see what it waits for without generating document 7 having
     * to rewrite document 6.
     */
    reverseDependencies: reverseDependencyIndexSchema.nullable(),

    /* Provenance. */
    generator: generatorMetadataSchema.nullable(),
    /** Why the last generation ran, when a user said. */
    regenerationReason: z.string().max(500).optional(),
    /** Version this one replaced. */
    supersedesVersion: z.number().int().positive().optional(),
    schemaVersion: z.number().int().positive(),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    approvedAt: z.string().datetime().optional(),
    finalAt: z.string().datetime().optional(),

    /** Optimistic-concurrency token for every write against this document. */
    recordVersion: z.number().int().nonnegative(),
  })
  .strict();

export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;

/** One line in the documents list: enough to render the step without the body. */
export const documentSummarySchema = z
  .object({
    type: documentTypeSchema,
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(400),
    order: z.number().int().positive(),
    status: documentStatusSchema,
    /** Null when the document may be generated. */
    lock: z
      .object({
        reason: z.string().max(60),
        summary: z.string().min(1).max(300),
      })
      .strict()
      .nullable(),
    implemented: z.boolean(),
    version: z.number().int().nonnegative(),
    currentness: documentCurrentnessSchema,
    blockerCount: z.number().int().nonnegative(),
    validationSeverity: z.string().max(20).nullable(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

export type DocumentSummary = z.infer<typeof documentSummarySchema>;

/* ------------------------------------------------------------- versions */

/** A stored earlier version, listed for comparison and restoration. */
export const documentVersionSummarySchema = z
  .object({
    version: z.number().int().positive(),
    status: documentStatusSchema,
    /**
     * Whether that version's inputs are still the current ones.
     *
     * Computed per version from the upstream versions stored with it, which is
     * what makes "the version we issued in March is no longer current" a fact the
     * history can state without anybody editing the March document.
     */
    currentness: documentCurrentnessSchema,
    createdAt: z.string().datetime(),
    approvedAt: z.string().datetime().optional(),
    finalAt: z.string().datetime().optional(),
    baselineVersion: z.number().int().nonnegative().optional(),
    stackVersion: z.number().int().nonnegative().optional(),
    estimateVersion: z.number().int().nonnegative().optional(),
    /** Sections or rows, by shape. */
    contentCount: z.number().int().nonnegative(),
    /** How many sections a person had edited when this version was cut. */
    userEditedCount: z.number().int().nonnegative(),
    regenerationReason: z.string().max(500).optional(),
    validationSeverity: z.string().max(20).nullable(),
  })
  .strict();

export type DocumentVersionSummary = z.infer<typeof documentVersionSummarySchema>;

/** One difference between two versions of a document. */
export const DIFF_KINDS = ['ADDED', 'REMOVED', 'CHANGED', 'UNCHANGED'] as const;
export type DiffKind = (typeof DIFF_KINDS)[number];

export const documentDiffEntrySchema = z
  .object({
    kind: z.enum(DIFF_KINDS),
    /** Section key or feature id. */
    key: z.string().min(1).max(64),
    title: z.string().max(300),
    left: z.string().max(20_000).optional(),
    right: z.string().max(20_000).optional(),
  })
  .strict();

export type DocumentDiffEntry = z.infer<typeof documentDiffEntrySchema>;

export const documentDiffSchema = z
  .object({
    leftVersion: z.number().int().positive(),
    rightVersion: z.number().int().positive(),
    entries: z.array(documentDiffEntrySchema).max(2_000),
    changedCount: z.number().int().nonnegative(),
  })
  .strict();

export type DocumentDiff = z.infer<typeof documentDiffSchema>;

/**
 * Compares two versions by content key.
 *
 * Keyed rather than positional: a section inserted in the middle should show as
 * one addition, not as every later section having changed. Whitespace is
 * normalised so a reflowed paragraph is not reported as a rewrite.
 */
export function diffDocuments(
  left: { readonly version: number; readonly entries: readonly ContentEntry[] },
  right: { readonly version: number; readonly entries: readonly ContentEntry[] },
): DocumentDiff {
  const leftByKey = new Map(left.entries.map((entry) => [entry.key, entry]));
  const rightByKey = new Map(right.entries.map((entry) => [entry.key, entry]));
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])];

  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim();

  const entries = keys.map((key): DocumentDiffEntry => {
    const before = leftByKey.get(key);
    const after = rightByKey.get(key);

    if (!before) {
      return { kind: 'ADDED', key, title: after?.title ?? key, right: after?.body ?? '' };
    }

    if (!after) {
      return { kind: 'REMOVED', key, title: before.title, left: before.body };
    }

    const changed = normalise(before.body) !== normalise(after.body);

    return {
      kind: changed ? 'CHANGED' : 'UNCHANGED',
      key,
      title: after.title,
      left: before.body,
      right: after.body,
    };
  });

  return {
    leftVersion: left.version,
    rightVersion: right.version,
    entries,
    changedCount: entries.filter((entry) => entry.kind !== 'UNCHANGED').length,
  };
}

/** The comparable projection of a document, whatever its shape. */
export interface ContentEntry {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/* --------------------------------------------------------- write shapes */

export const generateDocumentSchema = z
  .object({
    useAi: z.boolean(),
    /** Why, when a person is regenerating something that already exists. */
    reason: z.string().max(500).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type GenerateDocument = z.infer<typeof generateDocumentSchema>;

export const approveDocumentSchema = z
  .object({
    /**
     * Explicit. Approving a client-facing document is a decision, and the value
     * of recording it is that somebody had to do something.
     */
    acknowledged: z.literal(true),
    note: z.string().max(1_000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ApproveDocument = z.infer<typeof approveDocumentSchema>;

export const reopenDocumentSchema = z
  .object({
    reason: z.string().min(1).max(500),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ReopenDocument = z.infer<typeof reopenDocumentSchema>;

export const restoreVersionSchema = z
  .object({
    version: z.number().int().positive(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RestoreVersion = z.infer<typeof restoreVersionSchema>;

export const markFinalSchema = z
  .object({
    /** Issuing is irreversible, so it is confirmed rather than implied. */
    acknowledged: z.literal(true),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type MarkFinal = z.infer<typeof markFinalSchema>;
