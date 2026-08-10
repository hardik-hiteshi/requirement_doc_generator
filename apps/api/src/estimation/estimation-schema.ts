import {
  COMPLEXITY_DRIVERS,
  COMPLEXITY_LEVELS,
  TASK_CATEGORIES,
  UNCERTAINTY_SOURCES,
} from '@wdrg/contracts';
import { z } from 'zod';

/**
 * What the estimation task is allowed to return.
 *
 * The narrowest AI schema in the application, and the narrowness is the design.
 * The model contributes an *assessment* — what kind of work this is, how hard,
 * which drivers, what nobody knows — and the application converts that into
 * hours through rules a person can read.
 *
 * Four fields are conspicuously absent:
 *
 * - **No hours, of any kind.** Not per role, not a total, not a range. A model
 *   returning hours would be returning the answer, and the whole hybrid model
 *   exists so that it does not.
 * - **No role split.** Which discipline does the work follows from the task
 *   category and the project's applicable roles, both of which the application
 *   knows better.
 * - **No technology.** The stack is locked. A model that could name one could
 *   substitute one.
 * - **No dependency or date.** Sequencing and scheduling are arithmetic, and a
 *   model's date lands in a contract.
 *
 * `.strict()` throughout: a model inventing a field has misunderstood the task,
 * and silently stripping the evidence of that is how a misunderstanding reaches
 * a plan.
 */
export const estimationAssessmentSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            /** Must be a requirement the run was given. Checked semantically. */
            requirementId: z.string().min(1).max(64),
            taskCategory: z.enum(TASK_CATEGORIES),
            complexity: z.enum(COMPLEXITY_LEVELS),
            /**
             * Why it is that complex.
             *
             * The application recomputes the level from these and shows the
             * result, so a level with no drivers behind it is visibly
             * unexplained rather than quietly authoritative.
             */
            complexityDrivers: z.array(z.enum(COMPLEXITY_DRIVERS)).max(14),
            /** What nobody knows. Raises the range; never assumed away. */
            uncertaintySources: z.array(z.enum(UNCERTAINTY_SOURCES)).max(8),
            /** One paragraph, specific to this requirement. */
            rationale: z.string().min(1).max(1_200),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type EstimationAssessmentOutput = z.infer<typeof estimationAssessmentSchema>;
