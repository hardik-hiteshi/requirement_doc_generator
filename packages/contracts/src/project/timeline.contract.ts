import { z } from 'zod';

/**
 * The required delivery timeline.
 *
 * Stored as structured data — a mode plus its one value — rather than a free
 * text field, because every later phase has to reason about it: estimation
 * compares required effort against it, scheduling converts it to dates, and the
 * Statement of Work quotes it. None of that is possible against "about 3 months".
 *
 * The modes are mutually exclusive by construction: a discriminated union cannot
 * carry both a duration and a deadline, so the invalid combination is
 * unrepresentable rather than merely rejected.
 */
export const TIMELINE_MODES = ['WORKING_DAYS', 'WEEKS', 'MONTHS', 'FIXED_DEADLINE'] as const;
export type TimelineMode = (typeof TIMELINE_MODES)[number];

/**
 * Technical bounds, defined once here so the browser and the server enforce the
 * same limits. These are sanity limits, not business advice — the product never
 * silently adjusts a timeline the user chose.
 */
export const TIMELINE_LIMITS = {
  workingDays: { min: 1, max: 1_000 },
  weeks: { min: 1, max: 208 },
  months: { min: 1, max: 48 },
  /** How far ahead a fixed deadline may be set, in days. */
  deadlineMaxDaysAhead: 3_650,
} as const;

/** `YYYY-MM-DD`. Calendar dates carry no time zone; a timestamp would imply one. */
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const calendarDateSchema = z
  .string()
  .regex(CALENDAR_DATE_PATTERN, 'Must be a calendar date in YYYY-MM-DD format')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    // Round-tripping catches values that match the pattern but are not real
    // dates, such as 2026-02-31.
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'Must be a real calendar date');

export const timelineSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('WORKING_DAYS'),
    workingDays: z
      .number()
      .int()
      .min(TIMELINE_LIMITS.workingDays.min)
      .max(TIMELINE_LIMITS.workingDays.max),
  }),
  z.object({
    mode: z.literal('WEEKS'),
    weeks: z.number().int().min(TIMELINE_LIMITS.weeks.min).max(TIMELINE_LIMITS.weeks.max),
  }),
  z.object({
    mode: z.literal('MONTHS'),
    months: z.number().int().min(TIMELINE_LIMITS.months.min).max(TIMELINE_LIMITS.months.max),
  }),
  z.object({
    mode: z.literal('FIXED_DEADLINE'),
    deadline: calendarDateSchema,
  }),
]);

export type Timeline = z.infer<typeof timelineSchema>;

export const updateTimelineRequestSchema = z.object({
  timeline: timelineSchema,
  /** Version the client last read. Rejected if the project moved on. */
  version: z.number().int().nonnegative(),
});

export type UpdateTimelineRequest = z.infer<typeof updateTimelineRequestSchema>;

/**
 * Renders a timeline for display. Kept beside the schema so the UI and any
 * server-side document text describe a timeline the same way.
 */
export function describeTimeline(timeline: Timeline): string {
  switch (timeline.mode) {
    case 'WORKING_DAYS':
      return `${timeline.workingDays} working day${timeline.workingDays === 1 ? '' : 's'}`;
    case 'WEEKS':
      return `${timeline.weeks} week${timeline.weeks === 1 ? '' : 's'}`;
    case 'MONTHS':
      return `${timeline.months} month${timeline.months === 1 ? '' : 's'}`;
    case 'FIXED_DEADLINE':
      return `delivery by ${timeline.deadline}`;
  }
}

/**
 * Checks a fixed deadline against a reference date.
 *
 * Separate from the schema because "in the past" depends on when you ask, and a
 * schema that consults the clock cannot be reasoned about or tested reliably.
 * The caller supplies the reference instant.
 */
export function validateDeadlineAgainst(
  timeline: Timeline,
  now: Date,
): { valid: true } | { valid: false; reason: string } {
  if (timeline.mode !== 'FIXED_DEADLINE') {
    return { valid: true };
  }

  const deadline = new Date(`${timeline.deadline}T00:00:00.000Z`);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (deadline.getTime() < today.getTime()) {
    return { valid: false, reason: 'The delivery deadline is in the past.' };
  }

  const daysAhead = Math.round((deadline.getTime() - today.getTime()) / 86_400_000);

  if (daysAhead > TIMELINE_LIMITS.deadlineMaxDaysAhead) {
    return {
      valid: false,
      reason: `The delivery deadline is more than ${TIMELINE_LIMITS.deadlineMaxDaysAhead} days away.`,
    };
  }

  return { valid: true };
}
