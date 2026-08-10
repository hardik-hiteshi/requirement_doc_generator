import { z } from 'zod';

import {
  CALENDAR_LIMITS,
  addWorkingDays,
  nextWorkingDay,
  type WorkingCalendar,
} from './calendar.contract';
import type { Dependency, DependencyType } from './dependency.contract';
import type { RoleKey } from './role.contract';

/**
 * When each thing happens, calculated here and nowhere else.
 *
 * **No model touches this.** A language model can propose that testing depends
 * on development, and it is useful at that. It cannot be allowed to say what
 * date anything lands on, because date arithmetic is exactly the kind of task
 * where a model produces a confident, plausible, wrong answer — and the answer
 * ends up in a contract.
 *
 * ## Duration is not effort divided by anything
 *
 * The scheduler walks the dependency graph in topological order and places each
 * task at the earliest working day its predecessors allow *and* its role has
 * capacity. Two things follow that a naive division would miss: work that must
 * be sequential stays sequential however many people are added, and a role with
 * one person cannot run four of its tasks at once.
 *
 * ## Relative and dated are the same computation
 *
 * Everything is computed in **working-day offsets from project day 1**. A start
 * date, if there is one, is applied at the end. That is what makes "change the
 * start date, recalculate the dates, do not touch the effort" a one-line
 * operation rather than a re-plan — and it means a project with no start date
 * gets a real schedule rather than a degraded one.
 */

export const scheduledTaskSchema = z
  .object({
    taskId: z.string().min(1).max(64),
    /** 1-based working day from project start. Day 1 is the first working day. */
    startDay: z.number().int().min(1),
    endDay: z.number().int().min(1),
    /** Working days this task occupies. */
    durationDays: z.number().int().min(1),
    /** The role doing it, which is what contends for capacity. */
    role: z.string().min(1).max(60),
    hours: z.number().min(0),
    predecessorIds: z.array(z.string().max(64)).max(50),
    /** Working days this could slip without moving the finish. */
    slackDays: z.number().int().min(0),
    onCriticalPath: z.boolean(),
    /** Only when the project has a concrete start date. */
    startDate: z.string().max(10).optional(),
    endDate: z.string().max(10).optional(),
  })
  .strict();

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const scheduleSchema = z
  .object({
    tasks: z.array(scheduledTaskSchema).max(2_000),
    /** Working days from day 1 to the last task finishing. */
    totalWorkingDays: z.number().int().min(0),
    criticalPath: z.array(z.string().max(64)).max(2_000),
    /** Present only when a start date was supplied. */
    startDate: z.string().max(10).optional(),
    finishDate: z.string().max(10).optional(),
    /** True when dates could not be produced, and why is on the snapshot. */
    relativeOnly: z.boolean(),
  })
  .strict();

export type Schedule = z.infer<typeof scheduleSchema>;

export interface SchedulableTask {
  readonly id: string;
  readonly role: RoleKey;
  readonly hours: number;
}

export interface ScheduleInput {
  readonly tasks: readonly SchedulableTask[];
  readonly dependencies: readonly Dependency[];
  readonly calendar: WorkingCalendar;
  /**
   * People available per role. A role absent from this map is unconstrained —
   * which is the right behaviour when no team was supplied, because the
   * schedule then answers "how long if we staff it properly?"
   */
  readonly peoplePerRole: Readonly<Record<string, number>>;
  /** Applied at the end. Absent means a relative schedule. */
  readonly startDate?: string;
  /** False forbids anything running at once — a single-person project. */
  readonly allowParallel: boolean;
}

/**
 * The whole schedule.
 *
 * Deterministic and total: the same input produces the same output, and a graph
 * with a cycle in it is not scheduled at all (the caller checks first, and this
 * degrades safely by dropping the unreachable tail rather than looping).
 */
export function buildSchedule(input: ScheduleInput): Schedule {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const order = topologicalOrder(input.tasks, input.dependencies);
  const placed = new Map<string, { start: number; end: number }>();

  /** Working day the next task for a role may begin, per person slot. */
  const roleSlots = new Map<string, number[]>();

  const slotsFor = (role: string): number[] => {
    if (!roleSlots.has(role)) {
      const people = input.allowParallel
        ? Math.max(1, Math.floor(input.peoplePerRole[role] ?? 1))
        : 1;

      roleSlots.set(
        role,
        Array.from({ length: people }, () => 1),
      );
    }

    return roleSlots.get(role)!;
  };

  const predecessorsOf = (taskId: string): Dependency[] =>
    input.dependencies.filter((dependency) => dependency.successorId === taskId);

  for (const taskId of order) {
    const task = byId.get(taskId);

    if (!task) {
      continue;
    }

    const durationDays = durationFor(task.hours, input.calendar);

    /* Earliest the dependencies allow. */
    let earliest = 1;

    for (const dependency of predecessorsOf(taskId)) {
      const predecessor = placed.get(dependency.predecessorId);

      if (!predecessor) {
        continue;
      }

      earliest = Math.max(
        earliest,
        constraintDay(dependency.type, predecessor, durationDays) + dependency.lagDays,
      );
    }

    /*
     * And the earliest a person is free. This is where role contention becomes
     * real: two backend tasks with one backend engineer cannot overlap, however
     * independent they are.
     */
    const slots = slotsFor(task.role);
    const slotIndex = slots.indexOf(Math.min(...slots));
    const start = Math.max(earliest, slots[slotIndex]!);
    const end = start + durationDays - 1;

    slots[slotIndex] = end + 1;
    placed.set(taskId, { start, end });
  }

  const totalWorkingDays = [...placed.values()].reduce(
    (latest, task) => Math.max(latest, task.end),
    0,
  );

  /* Latest each task could finish without moving the end. */
  const latestFinish = computeLatestFinish(
    order,
    input.dependencies,
    placed,
    byId,
    input.calendar,
    totalWorkingDays,
  );

  const tasks: ScheduledTask[] = input.tasks
    .filter((task) => placed.has(task.id))
    .map((task) => {
      const slot = placed.get(task.id)!;
      const slack = Math.max(0, (latestFinish.get(task.id) ?? slot.end) - slot.end);

      return {
        taskId: task.id,
        startDay: slot.start,
        endDay: slot.end,
        durationDays: slot.end - slot.start + 1,
        role: task.role,
        hours: Number(task.hours.toFixed(2)),
        predecessorIds: predecessorsOf(task.id).map((dependency) => dependency.predecessorId),
        slackDays: slack,
        onCriticalPath: slack === 0,
        ...(input.startDate
          ? {
              startDate: addWorkingDays(
                nextWorkingDay(input.startDate, input.calendar),
                slot.start,
                input.calendar,
              ),
              endDate: addWorkingDays(
                nextWorkingDay(input.startDate, input.calendar),
                slot.end,
                input.calendar,
              ),
            }
          : {}),
      };
    })
    .sort(
      (first, second) =>
        first.startDay - second.startDay || first.taskId.localeCompare(second.taskId),
    );

  return {
    tasks,
    totalWorkingDays,
    /*
     * The critical path is every zero-slack task in schedule order. Derived
     * from the arithmetic rather than declared — which is the point: a model
     * asked to name the critical path names something plausible.
     */
    criticalPath: tasks.filter((task) => task.onCriticalPath).map((task) => task.taskId),
    ...(input.startDate
      ? {
          startDate: nextWorkingDay(input.startDate, input.calendar),
          finishDate: addWorkingDays(
            nextWorkingDay(input.startDate, input.calendar),
            totalWorkingDays,
            input.calendar,
          ),
        }
      : {}),
    relativeOnly: input.startDate === undefined,
  };
}

/** Working days a number of hours occupies at the calendar's day length. */
export function durationFor(hours: number, calendar: WorkingCalendar): number {
  if (hours <= 0) {
    return 1;
  }

  return Math.max(1, Math.ceil(hours / calendar.hoursPerDay));
}

/** The day a successor may begin, given a dependency type. */
function constraintDay(
  type: DependencyType,
  predecessor: { start: number; end: number },
  durationDays: number,
): number {
  switch (type) {
    case 'FINISH_TO_START':
      return predecessor.end + 1;
    case 'START_TO_START':
      return predecessor.start;
    case 'FINISH_TO_FINISH':
      // Finish no earlier than the predecessor finishes, so back off by the
      // successor's own duration.
      return Math.max(1, predecessor.end - durationDays + 1);
    case 'START_TO_FINISH':
      return Math.max(1, predecessor.start - durationDays + 1);
  }
}

/**
 * Tasks in an order where every predecessor comes first.
 *
 * Kahn's algorithm, with a deterministic tie-break so two runs over the same
 * graph produce the same schedule. Anything left over is in a cycle; it is
 * appended rather than dropped, so a caller that skipped validation gets a
 * strange schedule instead of a missing one — and the validator's blocking
 * cycle problem is what actually stops it reaching a user.
 */
export function topologicalOrder(
  tasks: readonly SchedulableTask[],
  dependencies: readonly Dependency[],
): readonly string[] {
  const ids = tasks.map((task) => task.id);
  const live = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const successors = new Map<string, string[]>();

  for (const dependency of dependencies) {
    if (!live.has(dependency.predecessorId) || !live.has(dependency.successorId)) {
      continue;
    }

    indegree.set(dependency.successorId, (indegree.get(dependency.successorId) ?? 0) + 1);
    successors.set(dependency.predecessorId, [
      ...(successors.get(dependency.predecessorId) ?? []),
      dependency.successorId,
    ]);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;

    order.push(id);

    for (const successor of (successors.get(id) ?? []).sort()) {
      const remaining = (indegree.get(successor) ?? 0) - 1;

      indegree.set(successor, remaining);

      if (remaining === 0) {
        ready.push(successor);
        ready.sort();
      }
    }
  }

  return [...order, ...ids.filter((id) => !order.includes(id)).sort()];
}

/**
 * The latest each task could finish without delaying the project.
 *
 * Backward pass. Walked in reverse topological order so a task's successors are
 * always resolved before it — which is what makes a single pass sufficient.
 */
function computeLatestFinish(
  order: readonly string[],
  dependencies: readonly Dependency[],
  placed: ReadonlyMap<string, { start: number; end: number }>,
  byId: ReadonlyMap<string, SchedulableTask>,
  calendar: WorkingCalendar,
  projectEnd: number,
): ReadonlyMap<string, number> {
  const latest = new Map<string, number>();

  for (const taskId of [...order].reverse()) {
    if (!placed.has(taskId)) {
      continue;
    }

    const successors = dependencies.filter((dependency) => dependency.predecessorId === taskId);

    if (successors.length === 0) {
      latest.set(taskId, projectEnd);

      continue;
    }

    let bound = projectEnd;

    for (const dependency of successors) {
      const successorLatest = latest.get(dependency.successorId);
      const successorTask = byId.get(dependency.successorId);

      if (successorLatest === undefined || !successorTask) {
        continue;
      }

      const successorDuration = durationFor(successorTask.hours, calendar);
      const successorLatestStart = successorLatest - successorDuration + 1;

      switch (dependency.type) {
        case 'FINISH_TO_START':
          bound = Math.min(bound, successorLatestStart - 1 - dependency.lagDays);
          break;
        case 'START_TO_START':
          bound = Math.min(
            bound,
            successorLatestStart + (placed.get(taskId)!.end - placed.get(taskId)!.start),
          );
          break;
        case 'FINISH_TO_FINISH':
          bound = Math.min(bound, successorLatest - dependency.lagDays);
          break;
        case 'START_TO_FINISH':
          bound = Math.min(bound, successorLatest);
          break;
      }
    }

    latest.set(taskId, Math.max(placed.get(taskId)!.end, bound));
  }

  return latest;
}

/** A guard so a pathological graph cannot produce an unbounded schedule. */
export function isScheduleWithinBounds(schedule: Schedule): boolean {
  return schedule.totalWorkingDays <= CALENDAR_LIMITS.maxScheduleDays;
}
