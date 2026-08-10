import { z } from 'zod';

import { calendarDateSchema } from '../project/timeline.contract';

/**
 * Which days people work, and the arithmetic that follows from it.
 *
 * Small, boring and load-bearing. Every date in every later document comes out
 * of this file, so the two rules it follows matter more than its size.
 *
 * **Dates are calendar dates, never timestamps.** A working day is a day, not
 * an instant, and attaching a time to it would attach a time zone — which is
 * how a plan that reads "Friday" in one office reads "Saturday" in another. All
 * arithmetic happens at UTC midnight on `YYYY-MM-DD` values and comes back out
 * in the same form.
 *
 * **Nothing here invents a date.** When the project has no start date, the
 * scheduler never calls anything in this file that produces one. Relative
 * scheduling — Day 1, Week 3 — is a separate path, not a calendar with the
 * labels changed.
 */

export const CALENDAR_LIMITS = {
  workingDaysPerWeek: { min: 1, max: 7 },
  hoursPerDay: { min: 1, max: 24 },
  maxHolidays: 200,
  /** A hard stop so a bad dependency graph cannot walk the calendar forever. */
  maxScheduleDays: 5_000,
} as const;

/** 0 = Sunday, matching `Date.getUTCDay()`. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const workingCalendarSchema = z
  .object({
    /**
     * Which weekdays are working days, as `Date.getUTCDay()` numbers.
     *
     * A list rather than a count, because "five days a week" does not say which
     * five — a Sunday-to-Thursday week is normal in much of the world, and a
     * count would quietly reschedule those projects onto the wrong days.
     */
    workingWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hoursPerDay: z
      .number()
      .min(CALENDAR_LIMITS.hoursPerDay.min)
      .max(CALENDAR_LIMITS.hoursPerDay.max),
    /** Public holidays and shutdowns. Calendar dates, never ranges. */
    holidays: z.array(calendarDateSchema).max(CALENDAR_LIMITS.maxHolidays),
    /** Working days the client is expected to take reviewing. */
    clientReviewDays: z.number().int().min(0).max(365),
    uatDays: z.number().int().min(0).max(365),
    deploymentDays: z.number().int().min(0).max(365),
  })
  .strict();

export type WorkingCalendar = z.infer<typeof workingCalendarSchema>;

/**
 * The default, and the reason it is what it is.
 *
 * **Six and a half hours, not eight.** Eight hours of paid time is not eight
 * hours of engineering: there are standups, reviews of other people's work,
 * interruptions, context switches and the twenty minutes after lunch. Planning
 * at eight is the single most common way an estimate that was correct becomes a
 * schedule that is wrong, and it is wrong in the direction that hurts.
 *
 * It is a default and it is visible, which is what the specification asks for —
 * the user can change it, and the number is on the screen rather than buried.
 */
export const DEFAULT_CALENDAR: WorkingCalendar = {
  workingWeekdays: [1, 2, 3, 4, 5],
  hoursPerDay: 6.5,
  holidays: [],
  clientReviewDays: 0,
  uatDays: 0,
  deploymentDays: 0,
};

export const DEFAULT_PRODUCTIVE_HOURS_NOTE =
  'Six and a half productive hours a day, not eight. The rest of a working day goes on standups, reviewing other people’s work, interruptions and context switching. You can change this.';

/* -------------------------------------------------------------- helpers */

/** `YYYY-MM-DD` to a UTC-midnight Date. */
export function parseCalendarDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** UTC-midnight Date back to `YYYY-MM-DD`. */
export function formatCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const parsed = parseCalendarDate(date);

  parsed.setUTCDate(parsed.getUTCDate() + days);

  return formatCalendarDate(parsed);
}

export function isWorkingDay(date: string, calendar: WorkingCalendar): boolean {
  const weekday = parseCalendarDate(date).getUTCDay();

  return calendar.workingWeekdays.includes(weekday) && !calendar.holidays.includes(date);
}

/**
 * The first working day on or after a date.
 *
 * Bounded, because a calendar with no working weekdays would otherwise loop
 * forever. The schema forbids that, and this does not rely on the schema having
 * been applied.
 */
export function nextWorkingDay(date: string, calendar: WorkingCalendar): string {
  let candidate = date;

  for (let step = 0; step < CALENDAR_LIMITS.maxScheduleDays; step += 1) {
    if (isWorkingDay(candidate, calendar)) {
      return candidate;
    }

    candidate = addDays(candidate, 1);
  }

  return candidate;
}

/**
 * The date `count` working days after `from`, counting `from` as day one.
 *
 * `addWorkingDays(monday, 1)` is that Monday: one working day of work starting
 * Monday finishes on Monday. Off-by-one here shifts every date in every
 * document, so the convention is stated rather than implied.
 */
export function addWorkingDays(from: string, count: number, calendar: WorkingCalendar): string {
  if (count <= 0) {
    return nextWorkingDay(from, calendar);
  }

  let current = nextWorkingDay(from, calendar);
  let remaining = count - 1;

  while (remaining > 0) {
    current = nextWorkingDay(addDays(current, 1), calendar);
    remaining -= 1;
  }

  return current;
}

/** Working days from `from` to `to` inclusive. Zero when `to` precedes `from`. */
export function workingDaysBetween(from: string, to: string, calendar: WorkingCalendar): number {
  if (parseCalendarDate(to).getTime() < parseCalendarDate(from).getTime()) {
    return 0;
  }

  let count = 0;
  let current = from;

  for (let step = 0; step < CALENDAR_LIMITS.maxScheduleDays; step += 1) {
    if (isWorkingDay(current, calendar)) {
      count += 1;
    }

    if (current === to) {
      return count;
    }

    current = addDays(current, 1);
  }

  return count;
}

/** Working days available in a span of calendar weeks. */
export function workingDaysInWeeks(weeks: number, calendar: WorkingCalendar): number {
  return Math.floor(weeks * calendar.workingWeekdays.length);
}

/**
 * How many working days a timeline allows.
 *
 * The number the whole feasibility calculation compares against, so it is
 * derived from the user's stated timeline and nothing else. A month is
 * approximated as 4.345 weeks — the actual mean — rather than four, because
 * rounding down here silently shortens every monthly deadline.
 */
export function timelineWorkingDays(
  timeline:
    | { mode: 'WORKING_DAYS'; workingDays: number }
    | { mode: 'WEEKS'; weeks: number }
    | { mode: 'MONTHS'; months: number }
    | { mode: 'FIXED_DEADLINE'; deadline: string },
  calendar: WorkingCalendar,
  /** Required for `FIXED_DEADLINE`; without it the deadline cannot be measured. */
  startDate?: string,
): number | null {
  switch (timeline.mode) {
    case 'WORKING_DAYS':
      return timeline.workingDays;
    case 'WEEKS':
      return workingDaysInWeeks(timeline.weeks, calendar);
    case 'MONTHS':
      return workingDaysInWeeks(timeline.months * 4.345, calendar);
    case 'FIXED_DEADLINE':
      /*
       * A deadline with no start date is a date, not a duration. Returning
       * anything here would mean inventing a start — so it returns null and the
       * feasibility view says plainly that it needs one.
       */
      return startDate ? workingDaysBetween(startDate, timeline.deadline, calendar) : null;
  }
}

/* ------------------------------------------------------------- validation */

export const updateCalendarSchema = z
  .object({
    calendar: workingCalendarSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type UpdateCalendar = z.infer<typeof updateCalendarSchema>;

/** Whether a calendar change is big enough to invalidate an approved estimate. */
export function isMaterialCalendarChange(before: WorkingCalendar, after: WorkingCalendar): boolean {
  return (
    before.hoursPerDay !== after.hoursPerDay ||
    before.workingWeekdays.length !== after.workingWeekdays.length ||
    [...before.workingWeekdays].sort().join() !== [...after.workingWeekdays].sort().join() ||
    before.holidays.length !== after.holidays.length ||
    before.clientReviewDays !== after.clientReviewDays ||
    before.uatDays !== after.uatDays ||
    before.deploymentDays !== after.deploymentDays
  );
}
