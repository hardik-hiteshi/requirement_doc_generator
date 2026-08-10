import { z } from 'zod';

import { calendarDateSchema } from './timeline.contract';

/**
 * The project start date, which is deliberately optional.
 *
 * Effort estimation never needs it: effort is hours of work, and hours do not
 * depend on which Monday the work begins. Only *calendar* scheduling needs a
 * start date. Modelling "we don't know yet" as a first-class mode — rather than
 * a null date — is what stops a later phase inventing a plausible-looking
 * Gantt chart from a date nobody supplied.
 */
export const START_DATE_MODES = [
  'NOT_CONFIRMED',
  'IMMEDIATELY_AFTER_APPROVAL',
  'TENTATIVE_DATE',
  'CONFIRMED_DATE',
] as const;

export type StartDateMode = (typeof START_DATE_MODES)[number];

/**
 * A date is carried only by the two modes that have one. The union makes
 * "confirmed date with no date" and "not confirmed, but here is a date"
 * unrepresentable.
 */
export const startDateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('NOT_CONFIRMED') }),
  z.object({ mode: z.literal('IMMEDIATELY_AFTER_APPROVAL') }),
  z.object({ mode: z.literal('TENTATIVE_DATE'), date: calendarDateSchema }),
  z.object({ mode: z.literal('CONFIRMED_DATE'), date: calendarDateSchema }),
]);

export type StartDate = z.infer<typeof startDateSchema>;

export const updateStartDateRequestSchema = z.object({
  startDate: startDateSchema,
  version: z.number().int().nonnegative(),
});

export type UpdateStartDateRequest = z.infer<typeof updateStartDateRequestSchema>;

/** True when the mode carries an actual calendar date. */
export function hasCalendarDate(
  startDate: StartDate,
): startDate is Extract<StartDate, { date: string }> {
  return startDate.mode === 'TENTATIVE_DATE' || startDate.mode === 'CONFIRMED_DATE';
}

/**
 * Whether calendar scheduling is possible.
 *
 * Used by the UI to explain honestly what the user will and will not get. Later
 * phases use the same helper to decide between relative ("Week 3") and absolute
 * ("17 March") scheduling, so the explanation and the behaviour cannot diverge.
 */
export function supportsCalendarScheduling(startDate: StartDate): boolean {
  return hasCalendarDate(startDate);
}

/**
 * Whether a fixed deadline and a concrete start date contradict each other.
 *
 * The two values are set independently and either write can create the
 * contradiction, so the check lives beside neither of them. It applies only when
 * both are actually known: a deadline with `NOT_CONFIRMED` or
 * `IMMEDIATELY_AFTER_APPROVAL` is incomplete, not wrong, and the estimate says so
 * rather than refusing it.
 *
 * Compared as strings, which is exact for `YYYY-MM-DD` and avoids constructing
 * dates in a time zone neither value carries.
 */
export function validateDeadlineAgainstStart(
  timeline: { mode: string; deadline?: string } | undefined,
  startDate: StartDate | undefined,
): { valid: true } | { valid: false; reason: string } {
  if (timeline?.mode !== 'FIXED_DEADLINE' || !timeline.deadline) {
    return { valid: true };
  }

  if (!startDate || !hasCalendarDate(startDate)) {
    return { valid: true };
  }

  if (startDate.date > timeline.deadline) {
    return {
      valid: false,
      reason: `The delivery deadline (${timeline.deadline}) is before the start date (${startDate.date}). One of the two has to move, and which one is your decision.`,
    };
  }

  return { valid: true };
}

export const START_DATE_MODE_LABELS: Readonly<Record<StartDateMode, string>> = {
  NOT_CONFIRMED: 'Start date not confirmed',
  IMMEDIATELY_AFTER_APPROVAL: 'Start immediately after approval',
  TENTATIVE_DATE: 'Tentative start date',
  CONFIRMED_DATE: 'Confirmed start date',
};

export const START_DATE_MODE_DESCRIPTIONS: Readonly<Record<StartDateMode, string>> = {
  NOT_CONFIRMED:
    'Estimates and relative schedules (Week 1, Week 2…) are produced. Calendar dates are not.',
  IMMEDIATELY_AFTER_APPROVAL:
    'Planning is relative to approval. Calendar dates appear once an actual date is set.',
  TENTATIVE_DATE: 'Calendar dates are calculated and can be recalculated if the date moves.',
  CONFIRMED_DATE: 'Calendar dates are calculated against a fixed start.',
};
