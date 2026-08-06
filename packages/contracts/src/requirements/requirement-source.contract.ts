import { z } from 'zod';

import { extractedContentSchema } from './extracted-content.contract';
import { SOURCE_STATUSES } from './source-status';
import { sourceKindSchema } from './source-formats';

/**
 * A requirement source: something the client gave us to read.
 *
 * Pasted text and uploaded files are the same kind of thing — evidence with a
 * lifecycle, a review state and a revision history — so they share one record
 * rather than living in separate collections that would need every downstream
 * query written twice. What differs between them is captured in the optional
 * `file` block, which is present only for uploads.
 *
 * Pasted text is deliberately *not* folded into project metadata. It is
 * evidence, and evidence needs provenance, versions and a review trail that
 * project fields do not have.
 */

export const SOURCE_ID_PATTERN = /^src_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export const sourceIdSchema = z.string().regex(SOURCE_ID_PATTERN, {
  message: 'Not a requirement-source identifier.',
});

export function isSourceId(value: string): boolean {
  return SOURCE_ID_PATTERN.test(value);
}

export const SOURCE_LIMITS = {
  title: { min: 1, max: 200 },
  /**
   * Pasted text. Generous enough for a full requirement brief, bounded so a
   * paste cannot become a denial-of-service against the extractor or the model
   * context in Phase 4.
   */
  text: { min: 1, max: 500_000 },
  filename: { max: 255 },
} as const;

/* ------------------------------------------------------------------ file */

export const VALIDATION_RESULTS = ['PENDING', 'PASSED', 'REJECTED'] as const;
export const MALWARE_SCAN_RESULTS = ['NOT_SCANNED', 'CLEAN', 'INFECTED', 'UNAVAILABLE'] as const;

/**
 * File facts, as verified rather than as claimed.
 *
 * `declaredMimeType` is what the browser said; `detectedMimeType` is what the
 * bytes say. Both are kept, because a mismatch between them is exactly the
 * signal a rejection is based on, and discarding the claim would leave the
 * rejection unexplainable after the fact.
 *
 * The storage key is **not** here. It is an internal address, not something a
 * client needs, and exposing it would turn an implementation detail into a
 * thing users could try to use.
 */
export const sourceFileSchema = z
  .object({
    /** Exactly as uploaded. Displayed, never used to build a path. */
    originalFilename: z.string().min(1).max(SOURCE_LIMITS.filename.max),
    /** Normalised for safe display: no control characters, no separators. */
    displayFilename: z.string().min(1).max(SOURCE_LIMITS.filename.max),
    extension: z.string().min(1).max(10),
    declaredMimeType: z.string().min(1).max(200),
    detectedMimeType: z.string().min(1).max(200).optional(),
    sizeBytes: z.number().int().nonnegative(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    validationResult: z.enum(VALIDATION_RESULTS),
    malwareScanResult: z.enum(MALWARE_SCAN_RESULTS),
    /** True when this file's checksum already existed in the project. */
    duplicateOf: sourceIdSchema.optional(),
    /** True when the file reached us through legacy conversion. */
    convertedFrom: z.string().max(10).optional(),
  })
  .strict();

export type SourceFile = z.infer<typeof sourceFileSchema>;

/* ---------------------------------------------------------------- review */

export const REVIEW_STATUSES = ['NOT_REVIEWED', 'IN_REVIEW', 'REVIEWED'] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/**
 * One saved correction.
 *
 * Revisions are append-only and the original extraction is revision 0, which is
 * why "restore the original" is a read rather than an undo — nothing has to be
 * reversed, because nothing was overwritten.
 */
export const contentRevisionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    /** `EXTRACTION` for revision 0; every later revision is `CORRECTION`. */
    origin: z.enum(['EXTRACTION', 'CORRECTION', 'RESTORE']),
    createdAt: z.iso.datetime(),
    /** Blocks the user changed, by id. Empty for revision 0. */
    changedBlockIds: z.array(z.string()),
    note: z.string().max(500).optional(),
  })
  .strict();

export type ContentRevision = z.infer<typeof contentRevisionSchema>;

/* ---------------------------------------------------------------- source */

export const requirementSourceSchema = z
  .object({
    sourceId: sourceIdSchema,
    kind: sourceKindSchema,
    status: z.enum(SOURCE_STATUSES),
    title: z.string().min(SOURCE_LIMITS.title.min).max(SOURCE_LIMITS.title.max),
    /** Optimistic-concurrency counter, as on the project. */
    version: z.number().int().nonnegative(),
    reviewStatus: reviewStatusSchema,
    reviewedAt: z.iso.datetime().optional(),

    /** Present only for `PASTED_TEXT`. */
    text: z.string().max(SOURCE_LIMITS.text.max).optional(),
    /** Present only for `FILE`. */
    file: sourceFileSchema.optional(),

    /**
     * The content later phases consume: revision 0 if untouched, otherwise the
     * latest correction. Named `effective` rather than `content` so no caller
     * can reach for "the content" and silently get the unreviewed original.
     */
    effectiveContent: extractedContentSchema.optional(),
    /** Revision 0, always. Retained so a correction is never destructive. */
    originalContent: extractedContentSchema.optional(),
    currentRevision: z.number().int().nonnegative(),
    revisions: z.array(contentRevisionSchema),

    /** Safe, user-facing failure summary. Detail stays in the logs. */
    failureCode: z.string().max(100).optional(),
    failureMessage: z.string().max(500).optional(),
    retryCount: z.number().int().nonnegative(),

    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().optional(),
  })
  .strict();

export type RequirementSource = z.infer<typeof requirementSourceSchema>;

/** A source in a list: everything needed to render a row, and nothing heavier. */
export const requirementSourceSummarySchema = requirementSourceSchema
  .omit({ effectiveContent: true, originalContent: true, revisions: true, text: true })
  .extend({
    /** Character count, so the UI can show size without shipping the text. */
    textLength: z.number().int().nonnegative().optional(),
    blockCount: z.number().int().nonnegative().optional(),
    warningCount: z.number().int().nonnegative().optional(),
    lowConfidenceBlockCount: z.number().int().nonnegative().optional(),
  });

export type RequirementSourceSummary = z.infer<typeof requirementSourceSummarySchema>;

/* --------------------------------------------------------------- requests */

export const addTextSourceRequestSchema = z
  .object({
    title: z.string().trim().min(SOURCE_LIMITS.title.min).max(SOURCE_LIMITS.title.max),
    text: z.string().min(SOURCE_LIMITS.text.min).max(SOURCE_LIMITS.text.max),
  })
  .strict();

export type AddTextSourceRequest = z.infer<typeof addTextSourceRequestSchema>;

export const updateTextSourceRequestSchema = z
  .object({
    version: z.number().int().nonnegative(),
    title: z.string().trim().min(SOURCE_LIMITS.title.min).max(SOURCE_LIMITS.title.max),
    text: z.string().min(SOURCE_LIMITS.text.min).max(SOURCE_LIMITS.text.max),
  })
  .strict();

export type UpdateTextSourceRequest = z.infer<typeof updateTextSourceRequestSchema>;

/** A correction: only the blocks that changed, addressed by id. */
export const correctContentRequestSchema = z
  .object({
    version: z.number().int().nonnegative(),
    corrections: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(64),
            text: z.string().max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    note: z.string().max(500).optional(),
  })
  .strict();

export type CorrectContentRequest = z.infer<typeof correctContentRequestSchema>;

export const versionedSourceRequestSchema = z
  .object({ version: z.number().int().nonnegative() })
  .strict();

export type VersionedSourceRequest = z.infer<typeof versionedSourceRequestSchema>;

/* -------------------------------------------------------------- responses */

export const sourceListResponseSchema = z
  .object({
    sources: z.array(requirementSourceSummarySchema),
    /** Bytes used by this project's files, against the configured quota. */
    usage: z
      .object({
        fileCount: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        maxFiles: z.number().int().positive(),
        maxTotalBytes: z.number().int().positive(),
        maxFileBytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type SourceListResponse = z.infer<typeof sourceListResponseSchema>;

/** One entry in a multi-file upload response — success and failure together. */
export const uploadOutcomeSchema = z
  .object({
    originalFilename: z.string(),
    accepted: z.boolean(),
    source: requirementSourceSummarySchema.optional(),
    /** Set when `accepted` is false. A stable code plus a safe message. */
    errorCode: z.string().max(100).optional(),
    errorMessage: z.string().max(500).optional(),
    /** Set when the file matched one already in the project. */
    duplicateOfSourceId: sourceIdSchema.optional(),
  })
  .strict();

export type UploadOutcome = z.infer<typeof uploadOutcomeSchema>;

export const uploadResponseSchema = z.object({ outcomes: z.array(uploadOutcomeSchema) }).strict();

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
