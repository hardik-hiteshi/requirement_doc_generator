import { z } from 'zod';

import { aiTaskExecutionSchema, aiTaskIdSchema } from './ai-task.contract';
import { ANALYSIS_LIMITS } from './analysis-limits';

/**
 * One pass of the analysis pipeline over a project's reviewed sources.
 *
 * A run is a first-class record rather than a background side effect, because
 * three questions have to be answerable afterwards: *what did it read*, *what
 * did it do to each part*, and *what did it fail at*. A pipeline that leaves no
 * trace can produce a baseline nobody can audit.
 *
 * Runs are versioned and never overwrite each other. Re-analysing supersedes
 * the previous run; it does not erase it.
 */

export const ANALYSIS_RUN_STATUSES = [
  /** Accepted, queued, nothing read yet. */
  'PENDING',
  /** Splitting reviewed content into bounded chunks. */
  'CHUNKING',
  /** Per-chunk work: normalise, classify, extract. */
  'ANALYSING',
  /**
   * Cross-chunk work.
   *
   * The stage that makes chunking safe rather than merely cheap: duplicates,
   * conflicts and terminology are only visible once every chunk's candidates
   * are on the table together.
   */
  'RECONCILING',
  /** Scoring, coverage, alignment, blockers, and the draft baseline. */
  'FINALISING',
  'COMPLETED',
  /** Ended with no usable baseline. `failureReason` says why. */
  'FAILED',
  'CANCELLED',
  /** A later run replaced it. */
  'SUPERSEDED',
] as const;

export type AnalysisRunStatus = (typeof ANALYSIS_RUN_STATUSES)[number];
export const analysisRunStatusSchema = z.enum(ANALYSIS_RUN_STATUSES);

export const ANALYSIS_RUN_STATUS_LABELS: Readonly<Record<AnalysisRunStatus, string>> = {
  PENDING: 'Queued',
  CHUNKING: 'Preparing your documents',
  ANALYSING: 'Reading requirements',
  RECONCILING: 'Comparing across documents',
  FINALISING: 'Checking coverage and confidence',
  COMPLETED: 'Complete',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  SUPERSEDED: 'Replaced by a newer analysis',
};

/**
 * Permitted transitions.
 *
 * Forward only, except that any working state can fail or be cancelled, and a
 * completed run can be superseded by a later one. There is no path back into
 * work: a run that stopped is finished, and continuing means a new run.
 */
export const ANALYSIS_RUN_TRANSITIONS: Readonly<
  Record<AnalysisRunStatus, readonly AnalysisRunStatus[]>
> = {
  PENDING: ['CHUNKING', 'FAILED', 'CANCELLED'],
  CHUNKING: ['ANALYSING', 'FAILED', 'CANCELLED'],
  ANALYSING: ['RECONCILING', 'FAILED', 'CANCELLED'],
  RECONCILING: ['FINALISING', 'FAILED', 'CANCELLED'],
  FINALISING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: ['SUPERSEDED'],
  FAILED: [],
  CANCELLED: [],
  SUPERSEDED: [],
};

export function canTransitionRun(from: AnalysisRunStatus, to: AnalysisRunStatus): boolean {
  return from === to || (ANALYSIS_RUN_TRANSITIONS[from]?.includes(to) ?? false);
}

export function isRunFinished(status: AnalysisRunStatus): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status);
}

/* ------------------------------------------------------------- chunks */

/**
 * How a chunk's boundary was chosen.
 *
 * Recorded because it changes how much to trust cross-chunk reconciliation. A
 * chunk that ended where a document ended is a clean boundary; one that ended
 * because the budget ran out may have split a thought in half, and the
 * reconciliation stage is what puts it back together.
 */
export const CHUNK_BOUNDARIES = ['source_end', 'heading', 'size_limit', 'block_split'] as const;
export type ChunkBoundary = (typeof CHUNK_BOUNDARIES)[number];
export const chunkBoundarySchema = z.enum(CHUNK_BOUNDARIES);

/**
 * A bounded slice of evidence, analysed independently.
 *
 * **A chunk never crosses a source.** Two documents in one chunk would make
 * "which file did this come from" a question about the model's memory rather
 * than about the data, and traceability is the one thing that cannot be
 * approximate.
 *
 * **Nothing is ever silently truncated.** A block larger than the budget is
 * split at a sentence boundary into parts that are all analysed, with
 * `blockParts` recording the split. Dropping the tail of an oversized block
 * would lose a requirement while reporting complete coverage.
 */
export const analysisChunkSchema = z
  .object({
    id: z.string().min(1).max(80),
    runId: z.string().min(1).max(64),
    /** 0-based, in reading order. */
    index: z.number().int().nonnegative(),
    sourceId: z.string().min(1).max(64),
    sourceName: z.string().min(1).max(300),
    blockIds: z.array(z.string().max(64)).min(1),
    /** Blocks that had to be split, and into how many parts. */
    blockParts: z
      .array(
        z
          .object({
            blockId: z.string().min(1).max(64),
            parts: z.number().int().positive(),
          })
          .strict(),
      )
      .max(200),
    characterCount: z.number().int().nonnegative(),
    estimatedTokens: z.number().int().nonnegative(),
    boundary: chunkBoundarySchema,
    /** The heading in force where the chunk starts, when there is one. */
    heading: z.string().max(500).optional(),
    status: z.enum(['pending', 'analysed', 'failed', 'skipped']),
    failureReason: z.string().max(300).optional(),
  })
  .strict();

export type AnalysisChunk = z.infer<typeof analysisChunkSchema>;

/* ----------------------------------------------------- block disposition */

/**
 * What happened to one reviewed evidence block.
 *
 * Every block gets exactly one of these, and that completeness is what makes
 * coverage a real number instead of a ratio of things somebody remembered to
 * count. "No requirement here" is a *decision*, recorded with a reason — not
 * the absence of a record.
 */
export const BLOCK_DISPOSITIONS = [
  /** Produced at least one requirement item. */
  'covered',
  /** Read, judged not to state a requirement. The reason is stored. */
  'no_requirement',
  /** Its content duplicated another block's, already covered. */
  'duplicate_content',
  /** Its chunk failed. This is a gap, and it blocks approval. */
  'not_analysed',
] as const;

export type BlockDisposition = (typeof BLOCK_DISPOSITIONS)[number];
export const blockDispositionSchema = z.enum(BLOCK_DISPOSITIONS);

export const blockDispositionRecordSchema = z
  .object({
    sourceId: z.string().min(1).max(64),
    blockId: z.string().min(1).max(64),
    chunkId: z.string().max(80).optional(),
    disposition: blockDispositionSchema,
    /** Required for `no_requirement`: a claim like that has to be justified. */
    reason: z.string().max(500).optional(),
    itemIds: z.array(z.string().max(64)).max(50),
  })
  .strict();

export type BlockDispositionRecord = z.infer<typeof blockDispositionRecordSchema>;

/** Dispositions that count as accounted-for when coverage is calculated. */
export function isAccountedFor(disposition: BlockDisposition): boolean {
  return disposition !== 'not_analysed';
}

/* --------------------------------------------------------------- run */

export const ANALYSIS_FAILURE_REASONS = [
  'no_reviewed_sources',
  'provider_unavailable',
  'model_unavailable',
  'all_chunks_failed',
  'too_many_chunks',
  'too_many_items',
  'timeout',
  'cancelled',
  'internal_error',
] as const;

export type AnalysisFailureReason = (typeof ANALYSIS_FAILURE_REASONS)[number];
export const analysisFailureReasonSchema = z.enum(ANALYSIS_FAILURE_REASONS);

export const ANALYSIS_FAILURE_MESSAGES: Readonly<Record<AnalysisFailureReason, string>> = {
  no_reviewed_sources:
    'There is nothing to analyse yet. Upload documents and finish reviewing what was extracted from them.',
  provider_unavailable:
    'The analysis service is not responding. Check that your inference server is running, then start a new analysis.',
  model_unavailable:
    'The configured model is not available on the inference server. Install it, or configure one that is.',
  all_chunks_failed:
    'Every part of the analysis failed. Nothing was produced, and no baseline was created.',
  too_many_chunks:
    'This project has more content than one analysis can hold. Split it into smaller projects.',
  too_many_items: 'The analysis produced more requirements than one baseline may hold.',
  timeout: 'The analysis ran longer than the configured limit and was stopped.',
  cancelled: 'The analysis was cancelled.',
  internal_error: 'The analysis stopped unexpectedly. Nothing was saved from it.',
};

/** Live progress, for a screen that has to say what is happening. */
export const analysisProgressSchema = z
  .object({
    totalChunks: z.number().int().nonnegative(),
    analysedChunks: z.number().int().nonnegative(),
    failedChunks: z.number().int().nonnegative(),
    /** The task currently running, when one is. */
    currentTask: aiTaskIdSchema.optional(),
    currentChunkIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export type AnalysisProgress = z.infer<typeof analysisProgressSchema>;

export const analysisRunSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    /** 1-based, per project. Shown to the user as "Analysis 3". */
    sequence: z.number().int().positive(),
    status: analysisRunStatusSchema,
    /** The sources this run read, fixed when it started. */
    sourceIds: z.array(z.string().max(64)),
    /**
     * A digest of the reviewed content this run read.
     *
     * How the application knows a baseline is out of date without re-reading
     * anything: if the digest of the project's current reviewed content differs
     * from this, the sources have moved on.
     */
    contentDigest: z.string().min(1).max(128),
    progress: analysisProgressSchema,
    /** Every task execution, for audit and for showing what the model did. */
    executions: z.array(aiTaskExecutionSchema).max(2_000),
    modelProfileId: z.string().min(1).max(80),
    model: z.string().min(1).max(120),
    provider: z.string().min(1).max(60),
    promptRegistryChecksum: z.string().min(1).max(64),
    failureReason: analysisFailureReasonSchema.optional(),
    /** Set when this run produced one. A failed run has none. */
    baselineId: z.string().max(64).optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    /** Set when the user asked to stop. Checked between every task. */
    cancellationRequestedAt: z.iso.datetime().optional(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export type AnalysisRun = z.infer<typeof analysisRunSchema>;

/** What a caller may ask for when starting one. */
export const startAnalysisSchema = z
  .object({
    /**
     * Carry human decisions forward from the previous baseline.
     *
     * Default true, and turning it off is an explicit act. Re-analysis must
     * never silently discard an edit or an acceptance a person made — the model
     * proposes, and a proposal does not overwrite a decision.
     */
    preserveUserDecisions: z.boolean().default(true),
  })
  .strict();

export type StartAnalysis = z.infer<typeof startAnalysisSchema>;

export const MAX_CHUNKS = ANALYSIS_LIMITS.maxChunks;
