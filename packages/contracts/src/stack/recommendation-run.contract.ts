import { z } from 'zod';

import { aiTaskExecutionSchema } from '../analysis/ai-task.contract';
import { AI_FAILURE_REASONS } from '../analysis/ai-task.contract';
import { technologyCategorySchema } from './technology-category.contract';

/**
 * One attempt at recommending technologies, recorded whether or not it worked.
 *
 * A failed run is as much a fact as a successful one — *"the model was asked
 * for a database on 7 August and could not be reached"* explains an empty
 * category that would otherwise look like an oversight.
 *
 * **Sizes, not content.** `inputSize` and `outputSize` are character counts.
 * The requirements the run was given never appear here, and never appear in an
 * ordinary operational log: they are the client's confidential material, and a
 * run record is read by operators debugging a deployment.
 */

export const RECOMMENDATION_RUN_STATUSES = [
  'running',
  'completed',
  /** Some categories were filled and others were not. Which, is recorded. */
  'partial',
  'failed',
  'cancelled',
] as const;

export type RecommendationRunStatus = (typeof RECOMMENDATION_RUN_STATUSES)[number];
export const recommendationRunStatusSchema = z.enum(RECOMMENDATION_RUN_STATUSES);

export const RECOMMENDATION_RUN_STATUS_LABELS: Readonly<Record<RecommendationRunStatus, string>> = {
  running: 'Working',
  completed: 'Done',
  partial: 'Partly done',
  failed: 'Could not finish',
  cancelled: 'Stopped',
};

export const recommendationRunSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    /** The stack version this run was made against. */
    stackVersion: z.number().int().positive(),
    baselineVersion: z.number().int().positive(),
    projectTypes: z.array(z.string().max(40)).max(8),
    /** Categories the run was asked to fill. Never includes a decided one. */
    categoriesRequested: z.array(technologyCategorySchema).max(40),
    categoriesFilled: z.array(technologyCategorySchema).max(40),
    provider: z.string().min(1).max(60),
    model: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(20),
    /** Characters in, characters out. Never the text itself. */
    inputSize: z.number().int().nonnegative(),
    outputSize: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    status: recommendationRunStatusSchema,
    retryCount: z.number().int().nonnegative(),
    failures: z.array(z.enum(AI_FAILURE_REASONS)).max(20),
    executions: z.array(aiTaskExecutionSchema).max(20),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

export type RecommendationRun = z.infer<typeof recommendationRunSchema>;

export const startRecommendationSchema = z
  .object({
    /**
     * Limit the run to particular categories.
     *
     * Used after a baseline change, when only the affected categories need
     * looking at again. Absent means "every category that is still undecided" —
     * which is not the same as "every category", and never includes one the
     * user has decided.
     */
    categories: z.array(technologyCategorySchema).max(40).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type StartRecommendation = z.infer<typeof startRecommendationSchema>;
