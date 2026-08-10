import { z } from 'zod';

import { aiTaskExecutionSchema, AI_FAILURE_REASONS } from '../analysis/ai-task.contract';
import { recommendationRunStatusSchema } from '../stack/recommendation-run.contract';

/**
 * One attempt at estimating, recorded whether or not it worked.
 *
 * A failed run explains an unestimated requirement that would otherwise look
 * like an oversight. **Sizes, not content**: the requirements the run read are
 * the client's confidential material and a run record is what an operator looks
 * at while debugging a deployment.
 *
 * `preservedOverrides` is counted rather than named — that a re-estimation left
 * four of the user's figures alone is the fact worth recording, and which four
 * is visible in the plan itself.
 */
export const estimationRunSchema = z
  .object({
    id: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    estimateVersion: z.number().int().positive(),
    baselineVersion: z.number().int().nonnegative(),
    stackVersion: z.number().int().nonnegative(),
    requirementCount: z.number().int().nonnegative(),
    unitsProduced: z.number().int().nonnegative(),
    preservedOverrides: z.number().int().nonnegative(),
    provider: z.string().min(1).max(60),
    model: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(20),
    /** Which methodology produced the numbers. */
    productivityModelVersion: z.string().min(1).max(20),
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

export type EstimationRun = z.infer<typeof estimationRunSchema>;

export const startEstimationSchema = z
  .object({
    /**
     * Whether to ask a model at all.
     *
     * False runs the deterministic engine alone, which is the path that works
     * with no inference server — and the one a user picks when they want the
     * same answer twice.
     */
    useAi: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type StartEstimation = z.infer<typeof startEstimationSchema>;
