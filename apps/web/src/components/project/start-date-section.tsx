'use client';

import {
  hasCalendarDate,
  START_DATE_MODES,
  START_DATE_MODE_DESCRIPTIONS,
  START_DATE_MODE_LABELS,
  supportsCalendarScheduling,
  type ProjectResponse,
  type StartDate,
  type StartDateMode,
} from '@wdrg/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@wdrg/ui';
import { useState } from 'react';

import { useSectionSave } from '@/hooks/use-project';
import { updateStartDate } from '@/lib/project-api';
import { SaveStatus } from './save-status';

/**
 * The optional start date.
 *
 * The panel states plainly what each choice does and does not buy, because the
 * honest answer is not obvious: estimation works without a date, and only
 * calendar scheduling needs one. Leaving this unset must not feel like an error.
 */
export function StartDateSection({ project }: { project: ProjectResponse }) {
  const [startDate, setStartDate] = useState<StartDate>(
    () => project.startDate ?? { mode: 'NOT_CONFIRMED' },
  );

  const { save, state, message } = useSectionSave<{ startDate: StartDate }>({
    mutate: updateStartDate,
  });

  function changeMode(mode: StartDateMode) {
    if (mode === 'TENTATIVE_DATE' || mode === 'CONFIRMED_DATE') {
      const existing = hasCalendarDate(startDate) ? startDate.date : defaultStart();
      setStartDate({ mode, date: existing });
      return;
    }

    setStartDate({ mode });
  }

  return (
    <Card role="region" aria-labelledby="start-date-section-title">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle id="start-date-section-title">Project start date</CardTitle>
            <CardDescription>
              Optional. Effort estimates never need a start date — only calendar scheduling does. No
              date is ever assumed on your behalf.
            </CardDescription>
          </div>
          <SaveStatus state={state} message={message} />
        </div>
      </CardHeader>

      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            save({ startDate });
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">When does the work start?</legend>
            {START_DATE_MODES.map((mode) => (
              <label
                key={mode}
                className={`flex items-start gap-2.5 rounded-md border p-2.5 text-sm ${
                  startDate.mode === mode ? 'border-accent bg-accent-soft' : 'border-border'
                }`}
              >
                <input
                  type="radio"
                  name="start-date-mode"
                  value={mode}
                  checked={startDate.mode === mode}
                  onChange={() => changeMode(mode)}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{START_DATE_MODE_LABELS[mode]}</span>
                  <span className="text-xs text-muted">{START_DATE_MODE_DESCRIPTIONS[mode]}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {hasCalendarDate(startDate) ? (
            <Field label="Start date" required>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={startDate.date}
                  onChange={(event) =>
                    setStartDate({ mode: startDate.mode, date: event.target.value })
                  }
                />
              )}
            </Field>
          ) : null}

          <p className="rounded-md border border-border bg-surface-hover p-3 text-xs text-muted">
            {supportsCalendarScheduling(startDate)
              ? 'Calendar dates will be calculated for tasks, milestones and client dependencies once scheduling is available. Changing the date later recalculates them without changing approved scope or effort.'
              : 'Estimates, staffing and relative schedules (Week 1, Week 2…) will still be produced. Exact calendar dates become available only once you provide a start date — you can change this at any time.'}
          </p>

          <Button type="submit" disabled={state === 'saving'} className="self-start">
            {state === 'saving' ? 'Saving…' : 'Save start date'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function defaultStart(): string {
  return new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
}
