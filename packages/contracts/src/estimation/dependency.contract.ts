import { z } from 'zod';

/**
 * What has to happen before what.
 *
 * The reason a schedule is not "total hours divided by team size". Two hundred
 * hours of work that must happen in sequence takes longer than two hundred
 * hours that can happen at once, and a plan that ignores the difference is a
 * plan that misses.
 *
 * ## Four types, used sparingly
 *
 * All four of the standard relationships are supported because real projects
 * contain all four — but `FINISH_TO_START` covers the overwhelming majority,
 * and the others are offered rather than encouraged. A dependency graph nobody
 * can read is worse than a slightly imprecise one, and this application would
 * rather produce a schedule a delivery lead can argue with than one that is
 * technically richer and practically opaque.
 *
 * ## Cycles are fatal, and that is deliberate
 *
 * A cycle is not a scheduling difficulty; it is a statement that cannot be true.
 * `detectCycles` finds them, and an unresolved cycle blocks approval outright —
 * there is no "we will sort it out later" path, because a schedule computed
 * around a cycle is arbitrary.
 */

export const DEPENDENCY_TYPES = [
  /** B starts after A finishes. The ordinary case. */
  'FINISH_TO_START',
  /** B starts no earlier than A starts. Two things that begin together. */
  'START_TO_START',
  /** B finishes no earlier than A finishes. Testing that trails development. */
  'FINISH_TO_FINISH',
  /** B finishes no earlier than A starts. Rare, and usually a modelling error. */
  'START_TO_FINISH',
] as const;

export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);

export const DEPENDENCY_TYPE_LABELS: Readonly<Record<DependencyType, string>> = {
  FINISH_TO_START: 'must finish before this starts',
  START_TO_START: 'must start before this starts',
  FINISH_TO_FINISH: 'must finish before this finishes',
  START_TO_FINISH: 'must start before this finishes',
};

/** Why this dependency exists. Each is a fact somebody can check. */
export const DEPENDENCY_REASONS = [
  'shared_architecture',
  'data_model',
  'integration_contract',
  'test_target',
  'client_dependency',
  'deployment_order',
  'design_first',
  'user_defined',
] as const;

export type DependencyReason = (typeof DEPENDENCY_REASONS)[number];
export const dependencyReasonSchema = z.enum(DEPENDENCY_REASONS);

export const DEPENDENCY_REASON_LABELS: Readonly<Record<DependencyReason, string>> = {
  shared_architecture: 'It builds on shared foundations',
  data_model: 'It needs the data model to exist',
  integration_contract: 'It needs the integration to be in place',
  test_target: 'There is nothing to test until this is built',
  client_dependency: 'It waits on the client',
  deployment_order: 'It has to be deployed in this order',
  design_first: 'It needs the design first',
  user_defined: 'You said so',
};

export const dependencySchema = z
  .object({
    id: z.string().min(1).max(64),
    /** The estimate unit that must happen first. */
    predecessorId: z.string().min(1).max(64),
    /** The estimate unit that waits. */
    successorId: z.string().min(1).max(64),
    type: dependencyTypeSchema,
    reason: dependencyReasonSchema,
    /** Working days of enforced gap. Client review, a deployment window. */
    lagDays: z.number().int().min(0).max(120),
    /** True when a person added or kept it, which protects it from re-estimation. */
    userDefined: z.boolean(),
    note: z.string().max(600).optional(),
  })
  .strict()
  .refine(
    (dependency) => dependency.predecessorId !== dependency.successorId,
    'A task cannot depend on itself',
  );

export type Dependency = z.infer<typeof dependencySchema>;

/* ------------------------------------------------------------ validation */

export const DEPENDENCY_PROBLEM_KINDS = [
  'cycle',
  'self_reference',
  'missing_predecessor',
  'missing_successor',
  'excluded_task',
  'duplicate',
] as const;

export type DependencyProblemKind = (typeof DEPENDENCY_PROBLEM_KINDS)[number];

export interface DependencyProblem {
  readonly kind: DependencyProblemKind;
  /** Dependency ids involved, or unit ids for a cycle. */
  readonly ids: readonly string[];
  readonly summary: string;
  /** A cycle cannot be scheduled around; the others are recoverable. */
  readonly blocking: boolean;
}

export interface DependencyGraphInput {
  readonly dependencies: readonly Dependency[];
  /** Ids of the estimate units that are in the plan. */
  readonly taskIds: readonly string[];
  /** Ids the user excluded. A dependency on one of these is a dangling edge. */
  readonly excludedTaskIds: readonly string[];
}

/**
 * Everything wrong with the dependency graph.
 *
 * Pure and order-stable, so a test can assert the list and a reviewer sees the
 * same problems in the same order on every visit.
 */
export function validateDependencies(input: DependencyGraphInput): readonly DependencyProblem[] {
  const problems: DependencyProblem[] = [];
  const known = new Set(input.taskIds);
  const excluded = new Set(input.excludedTaskIds);
  const seen = new Set<string>();

  for (const dependency of input.dependencies) {
    if (dependency.predecessorId === dependency.successorId) {
      problems.push({
        kind: 'self_reference',
        ids: [dependency.id],
        summary: 'A task cannot wait for itself.',
        blocking: true,
      });

      continue;
    }

    const pairKey = `${dependency.predecessorId}->${dependency.successorId}:${dependency.type}`;

    if (seen.has(pairKey)) {
      problems.push({
        kind: 'duplicate',
        ids: [dependency.id],
        summary: 'The same dependency is recorded twice.',
        blocking: false,
      });
    }

    seen.add(pairKey);

    /*
     * An edge pointing at an excluded task is reported separately from one
     * pointing at nothing. The first means somebody removed a task and left the
     * link; the second means the graph refers to something that never existed.
     */
    for (const [id, role] of [
      [dependency.predecessorId, 'predecessor'],
      [dependency.successorId, 'successor'],
    ] as const) {
      if (excluded.has(id)) {
        problems.push({
          kind: 'excluded_task',
          ids: [dependency.id],
          summary: `This depends on a task you removed from the plan.`,
          blocking: false,
        });
      } else if (!known.has(id)) {
        problems.push({
          kind: role === 'predecessor' ? 'missing_predecessor' : 'missing_successor',
          ids: [dependency.id],
          summary: 'This points at a task that is not in the plan.',
          blocking: false,
        });
      }
    }
  }

  for (const cycle of detectCycles(input)) {
    problems.push({
      kind: 'cycle',
      ids: cycle,
      summary: `These tasks wait for each other in a loop: ${cycle.join(' → ')}.`,
      blocking: true,
    });
  }

  return problems;
}

/**
 * Every cycle in the graph, as a list of task ids.
 *
 * Iterative depth-first search with an explicit stack rather than recursion,
 * because a project can hold hundreds of tasks and a deep chain would otherwise
 * be one stack overflow away from a 500 on somebody's estimate.
 */
export function detectCycles(input: DependencyGraphInput): readonly (readonly string[])[] {
  const edges = new Map<string, string[]>();
  const live = new Set(input.taskIds.filter((id) => !input.excludedTaskIds.includes(id)));

  for (const dependency of input.dependencies) {
    if (!live.has(dependency.predecessorId) || !live.has(dependency.successorId)) {
      continue;
    }

    edges.set(dependency.predecessorId, [
      ...(edges.get(dependency.predecessorId) ?? []),
      dependency.successorId,
    ]);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();

  for (const start of [...live].sort()) {
    if (state.get(start)) {
      continue;
    }

    const path: string[] = [];
    const stack: { node: string; childIndex: number }[] = [{ node: start, childIndex: 0 }];

    state.set(start, 'visiting');
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = edges.get(frame.node) ?? [];

      if (frame.childIndex >= children.length) {
        state.set(frame.node, 'done');
        stack.pop();
        path.pop();

        continue;
      }

      const child = children[frame.childIndex]!;

      frame.childIndex += 1;

      if (state.get(child) === 'visiting') {
        const from = path.indexOf(child);
        const cycle = path.slice(from);
        // Normalised so the same loop found from two entry points is reported
        // once — otherwise a four-task cycle appears four times.
        const key = [...cycle].sort().join('|');

        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }

        continue;
      }

      if (state.get(child) === 'done') {
        continue;
      }

      state.set(child, 'visiting');
      path.push(child);
      stack.push({ node: child, childIndex: 0 });
    }
  }

  return cycles;
}

/** Whether anything in the graph stops a schedule being computed at all. */
export function hasBlockingDependencyProblem(problems: readonly DependencyProblem[]): boolean {
  return problems.some((problem) => problem.blocking);
}

/* --------------------------------------------------------- write shapes */

export const createDependencySchema = z
  .object({
    predecessorId: z.string().min(1).max(64),
    successorId: z.string().min(1).max(64),
    type: dependencyTypeSchema,
    reason: dependencyReasonSchema,
    lagDays: z.number().int().min(0).max(120),
    note: z.string().max(600).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine((input) => input.predecessorId !== input.successorId, 'A task cannot depend on itself');

export type CreateDependency = z.infer<typeof createDependencySchema>;
