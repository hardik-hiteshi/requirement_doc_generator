import { z } from 'zod';

import type { WorkingCalendar } from './calendar.contract';
import { roleLabel, type CustomEstimationRole, type RoleEffort } from './role.contract';

/**
 * How much work the team can actually do, and whether that is enough.
 *
 * The file that keeps **effort**, **duration** and **capacity** apart. They get
 * conflated constantly, and the conflation is the single most common way a plan
 * goes wrong:
 *
 * - **Effort** is hours of work. 320 hours is 320 hours.
 * - **Capacity** is hours available. Two people at 6.5 hours a day for four
 *   weeks is 260 hours.
 * - **Duration** is elapsed time, and it falls out of the other two *plus the
 *   dependency graph*. It is never `effort ÷ hours-per-day`.
 *
 * `320 hours = 8 weeks` is only true if somebody worked out who is doing it and
 * what has to wait for what. Nothing in this file will produce that equation on
 * its own.
 */

export const capacityLineSchema = z
  .object({
    role: z.string().min(1).max(60),
    /** Fractional on purpose — half a DevOps engineer is a real arrangement. */
    people: z.number().min(0).max(500),
    productiveHoursPerDay: z.number().min(0).max(24),
    workingDaysPerWeek: z.number().int().min(1).max(7),
    /** 0–1. Somebody at 60% is on this project three days in five. */
    availability: z.number().min(0).max(1),
    /** Working day this role becomes available, relative to project day 1. */
    availableFromDay: z.number().int().min(0).max(1_000),
    note: z.string().max(600).optional(),
  })
  .strict();

export type CapacityLine = z.infer<typeof capacityLineSchema>;

export const teamPlanSchema = z
  .object({
    /** Absent means the user has not told us, which is not the same as none. */
    supplied: z.boolean(),
    lines: z.array(capacityLineSchema).max(60),
  })
  .strict();

export type TeamPlan = z.infer<typeof teamPlanSchema>;

export const EMPTY_TEAM: TeamPlan = { supplied: false, lines: [] };

/** Hours one capacity line provides over a number of working days. */
export function lineCapacityHours(line: CapacityLine, workingDays: number): number {
  const usableDays = Math.max(0, workingDays - line.availableFromDay);

  return Number(
    (line.people * line.productiveHoursPerDay * line.availability * usableDays).toFixed(2),
  );
}

/* --------------------------------------------------------- utilisation */

export const utilisationSchema = z
  .object({
    role: z.string().min(1).max(60),
    /** Hours the plan needs from this role. */
    plannedHours: z.number().min(0),
    /** Hours the team can supply in the timeline. */
    availableHours: z.number().min(0),
    /** planned ÷ available. Above 1 means it does not fit. */
    utilisation: z.number().min(0),
    /** Hours short. Zero when it fits. */
    gapHours: z.number().min(0),
    /** People needed to close the gap, at the configured day length. */
    additionalPeople: z.number().min(0),
  })
  .strict();

export type Utilisation = z.infer<typeof utilisationSchema>;

/**
 * Above this, a role is being asked for more than a person sustains.
 *
 * Not 1.0. A role planned at exactly its theoretical capacity has no slack for
 * a sick day, a production incident, or an estimate that was slightly low —
 * which is every project. Flagging at 0.85 is the difference between a plan
 * that is tight and one that has already failed.
 */
export const SUSTAINABLE_UTILISATION = 0.85;

export interface CapacityInput {
  readonly plannedEffort: RoleEffort;
  readonly team: TeamPlan;
  readonly calendar: WorkingCalendar;
  /** Working days the stated timeline allows. Null when it cannot be derived. */
  readonly availableWorkingDays: number | null;
}

export interface CapacityResult {
  readonly byRole: readonly Utilisation[];
  readonly totalPlannedHours: number;
  readonly totalAvailableHours: number;
  readonly totalGapHours: number;
  /** True when the team was never supplied, so availability is unknown. */
  readonly capacityUnknown: boolean;
  /** Roles asked for more than is sustainable, even where they technically fit. */
  readonly overloadedRoles: readonly string[];
}

/**
 * What the plan asks of each role, against what the team can give.
 *
 * When no team was supplied this reports zero availability and the full effort
 * as a gap — which is honest rather than alarming, because the accompanying
 * `capacityUnknown` flag tells every reader that the right response is
 * `recommendStaffing`, not panic.
 */
export function calculateCapacity(input: CapacityInput): CapacityResult {
  const days = input.availableWorkingDays ?? 0;
  const roles = new Set([
    ...Object.keys(input.plannedEffort),
    ...input.team.lines.map((line) => line.role),
  ]);

  const byRole = [...roles]
    .sort()
    .map((role) => {
      const plannedHours = Number((input.plannedEffort[role] ?? 0).toFixed(2));
      const availableHours = Number(
        input.team.lines
          .filter((line) => line.role === role)
          .reduce((total, line) => total + lineCapacityHours(line, days), 0)
          .toFixed(2),
      );

      const gapHours = Number(Math.max(0, plannedHours - availableHours).toFixed(2));

      return {
        role,
        plannedHours,
        availableHours,
        utilisation:
          availableHours === 0
            ? plannedHours === 0
              ? 0
              : Number.POSITIVE_INFINITY
            : Number((plannedHours / availableHours).toFixed(3)),
        gapHours,
        additionalPeople: peopleForHours(gapHours, input.calendar, days),
      };
    })
    // Infinity is legitimate here — a role with work and nobody to do it — but
    // it cannot be stored or serialised, so it is capped at the schema bound.
    .map((line) => ({
      ...line,
      utilisation: Number.isFinite(line.utilisation) ? line.utilisation : 999,
    }));

  const totalPlannedHours = Number(
    byRole.reduce((total, line) => total + line.plannedHours, 0).toFixed(2),
  );
  const totalAvailableHours = Number(
    byRole.reduce((total, line) => total + line.availableHours, 0).toFixed(2),
  );

  return {
    byRole,
    totalPlannedHours,
    totalAvailableHours,
    totalGapHours: Number(byRole.reduce((total, line) => total + line.gapHours, 0).toFixed(2)),
    capacityUnknown: !input.team.supplied,
    overloadedRoles: byRole
      .filter((line) => line.plannedHours > 0 && line.utilisation > SUSTAINABLE_UTILISATION)
      .map((line) => line.role),
  };
}

/**
 * People needed to absorb some hours in the available time.
 *
 * Fractional, and stays fractional. Rounding every role up to a whole person is
 * how a recommendation acquires two extra full-time engineers who are each
 * needed for a day and a half — and how an estimate stops being believable.
 */
export function peopleForHours(
  hours: number,
  calendar: WorkingCalendar,
  workingDays: number,
): number {
  if (hours <= 0 || workingDays <= 0 || calendar.hoursPerDay <= 0) {
    return 0;
  }

  return Number((hours / (calendar.hoursPerDay * workingDays)).toFixed(2));
}

/* ------------------------------------------------- staffing recommendation */

export const staffingLineSchema = z
  .object({
    role: z.string().min(1).max(60),
    /** Fractional. 0.3 means roughly a day and a half a week. */
    people: z.number().min(0),
    hours: z.number().min(0),
    /** The honest reading of a fractional figure, in words. */
    note: z.string().max(300),
  })
  .strict();

export type StaffingLine = z.infer<typeof staffingLineSchema>;

/**
 * The team this plan would need, when nobody has said what the team is.
 *
 * Derived from effort, the timeline and the calendar — never from a template.
 * The note beside each fractional figure exists because "0.3 DevOps engineers"
 * is a real answer that reads as an error, and a reader who cannot interpret it
 * will round it up.
 */
export function recommendStaffing(input: {
  readonly plannedEffort: RoleEffort;
  readonly calendar: WorkingCalendar;
  readonly availableWorkingDays: number | null;
  readonly customRoles?: readonly CustomEstimationRole[];
}): readonly StaffingLine[] {
  const days = input.availableWorkingDays ?? 0;

  if (days <= 0) {
    return [];
  }

  return Object.entries(input.plannedEffort)
    .filter(([, hours]) => hours > 0)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([role, hours]) => {
      const people = peopleForHours(hours, input.calendar, days);

      return {
        role,
        people,
        hours: Number(hours.toFixed(2)),
        note: describeStaffing(people, roleLabel(role, input.customRoles ?? [])),
      };
    });
}

function describeStaffing(people: number, label: string): string {
  if (people >= 1) {
    const whole = Math.floor(people);
    const remainder = people - whole;

    return remainder < 0.1
      ? `${whole} full-time ${label.toLowerCase()}.`
      : `${whole} full-time plus roughly ${Math.round(remainder * 5)} day${
          Math.round(remainder * 5) === 1 ? '' : 's'
        } a week of another.`;
  }

  const daysPerWeek = Math.max(0.5, Math.round(people * 5 * 2) / 2);

  return `About ${daysPerWeek} day${daysPerWeek === 1 ? '' : 's'} a week — not a full-time person.`;
}

/* ---------------------------------------------------------- write shapes */

export const updateTeamPlanSchema = z
  .object({
    lines: z.array(capacityLineSchema).max(60),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateTeamPlan = z.infer<typeof updateTeamPlanSchema>;

/** Whether a capacity change is big enough to invalidate an approved estimate. */
export function isMaterialCapacityChange(before: TeamPlan, after: TeamPlan): boolean {
  if (before.supplied !== after.supplied || before.lines.length !== after.lines.length) {
    return true;
  }

  const key = (line: CapacityLine): string =>
    `${line.role}:${line.people}:${line.productiveHoursPerDay}:${line.availability}:${line.availableFromDay}`;

  return before.lines.map(key).sort().join('|') !== after.lines.map(key).sort().join('|');
}
