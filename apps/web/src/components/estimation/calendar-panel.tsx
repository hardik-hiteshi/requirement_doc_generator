'use client';

import { useState } from 'react';
import { CALENDAR_LIMITS, type EstimateSnapshot, type WorkingCalendar } from '@wdrg/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { useSetCalendar } from '@/hooks/use-estimation';

/**
 * The working week this plan is laid out on.
 *
 * Every duration in the estimate is hours divided by this, so it is the quietest
 * way for a plan to be wrong. Two numbers deserve saying out loud.
 *
 * **Productive hours a day defaults to six and a half, not eight.** Eight hours of
 * paid time is not eight hours of engineering, and planning at eight is the most
 * common way a correct estimate becomes an incorrect schedule — in the direction
 * that hurts. The number is on screen and editable rather than buried in a
 * constant.
 *
 * **Working days are named, not counted.** A Sunday-to-Thursday week is normal in
 * much of the world, and "five days" would quietly schedule those projects onto
 * the wrong dates.
 *
 * Review, UAT and deployment days are here because they are working days somebody
 * has to wait through. A plan that ends the day development finishes is a plan
 * that has forgotten the client.
 */
const WEEKDAYS = [
  { day: 1, label: 'Monday' },
  { day: 2, label: 'Tuesday' },
  { day: 3, label: 'Wednesday' },
  { day: 4, label: 'Thursday' },
  { day: 5, label: 'Friday' },
  { day: 6, label: 'Saturday' },
  { day: 0, label: 'Sunday' },
] as const;

export function CalendarPanel({ estimate }: { readonly estimate: EstimateSnapshot }) {
  const setCalendar = useSetCalendar();

  const [draft, setDraft] = useState<WorkingCalendar | null>(null);
  const [holiday, setHoliday] = useState('');
  const editing = draft !== null;
  const calendar = draft ?? estimate.calendar;

  const change = (changes: Partial<WorkingCalendar>): void => {
    setDraft({ ...calendar, ...changes });
  };

  const toggleWeekday = (day: number): void => {
    const next = calendar.workingWeekdays.includes(day)
      ? calendar.workingWeekdays.filter((candidate) => candidate !== day)
      : [...calendar.workingWeekdays, day].sort();

    /* At least one working day, or nothing can ever be scheduled. */
    if (next.length > 0) {
      change({ workingWeekdays: next });
    }
  };

  return (
    <Card role="region" aria-label="Working calendar">
      <CardHeader>
        <CardTitle>Working calendar</CardTitle>
        <CardDescription>
          Every duration here is hours divided by this. Six and a half productive hours a day is the
          default because eight hours of paid time is not eight hours of engineering.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm" data-testid="calendar-summary">
          {calendar.hoursPerDay} productive hours a day · {calendar.workingWeekdays.length} working
          days a week · {calendar.holidays.length} non-working{' '}
          {calendar.holidays.length === 1 ? 'date' : 'dates'} · {calendar.clientReviewDays} review,{' '}
          {calendar.uatDays} UAT, {calendar.deploymentDays} deployment days
        </p>

        {editing ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                Productive hours a day
                <input
                  type="number"
                  min={CALENDAR_LIMITS.hoursPerDay.min}
                  max={CALENDAR_LIMITS.hoursPerDay.max}
                  step={0.5}
                  className="rounded-md border border-border bg-surface p-2 text-sm"
                  value={calendar.hoursPerDay}
                  onChange={(event) => change({ hoursPerDay: Number(event.target.value) })}
                  data-testid="calendar-hours"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Client review days
                <input
                  type="number"
                  min={0}
                  className="rounded-md border border-border bg-surface p-2 text-sm"
                  value={calendar.clientReviewDays}
                  onChange={(event) => change({ clientReviewDays: Number(event.target.value) })}
                  data-testid="calendar-review"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                UAT days
                <input
                  type="number"
                  min={0}
                  className="rounded-md border border-border bg-surface p-2 text-sm"
                  value={calendar.uatDays}
                  onChange={(event) => change({ uatDays: Number(event.target.value) })}
                  data-testid="calendar-uat"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Deployment days
                <input
                  type="number"
                  min={0}
                  className="rounded-md border border-border bg-surface p-2 text-sm"
                  value={calendar.deploymentDays}
                  onChange={(event) => change({ deploymentDays: Number(event.target.value) })}
                  data-testid="calendar-deployment"
                />
              </label>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs">Working days of the week</legend>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((weekday) => (
                  <label key={weekday.day} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={calendar.workingWeekdays.includes(weekday.day)}
                      onChange={() => toggleWeekday(weekday.day)}
                      data-testid={`calendar-weekday-${weekday.day}`}
                    />
                    {weekday.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-xs">
                Add a non-working date
                <div className="flex gap-2">
                  <input
                    type="date"
                    className="rounded-md border border-border bg-surface p-2 text-sm"
                    value={holiday}
                    onChange={(event) => setHoliday(event.target.value)}
                    data-testid="calendar-holiday-input"
                  />
                  <Button
                    variant="secondary"
                    disabled={holiday === '' || calendar.holidays.includes(holiday)}
                    data-testid="calendar-holiday-add"
                    onClick={() => {
                      change({ holidays: [...calendar.holidays, holiday].sort() });
                      setHoliday('');
                    }}
                  >
                    Add
                  </Button>
                </div>
              </label>

              {calendar.holidays.length > 0 ? (
                <ul className="flex flex-wrap gap-2" data-testid="calendar-holidays">
                  {calendar.holidays.map((date) => (
                    <li key={date}>
                      <Button
                        variant="secondary"
                        data-testid={`calendar-holiday-remove-${date}`}
                        onClick={() =>
                          change({
                            holidays: calendar.holidays.filter((candidate) => candidate !== date),
                          })
                        }
                      >
                        {date} ✕
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={setCalendar.isPending}
                data-testid="calendar-save"
                onClick={() => {
                  void setCalendar
                    .mutateAsync({ calendar, expectedVersion: estimate.recordVersion })
                    .then(() => setDraft(null));
                }}
              >
                Use this calendar
              </Button>
              <Button
                variant="secondary"
                onClick={() => setDraft(null)}
                data-testid="calendar-cancel"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => setDraft({ ...estimate.calendar })}
            data-testid="calendar-edit"
          >
            Change the calendar
          </Button>
        )}

        {setCalendar.isError ? (
          <p role="alert" className="text-sm text-danger" data-testid="calendar-error">
            {setCalendar.error.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
