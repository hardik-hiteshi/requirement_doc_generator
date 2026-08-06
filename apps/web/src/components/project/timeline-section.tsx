'use client';

import {
  TIMELINE_LIMITS,
  type ProjectResponse,
  type Timeline,
  type TimelineMode,
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
import { updateTimeline } from '@/lib/project-api';
import { SaveStatus } from './save-status';

const MODE_LABELS: Record<TimelineMode, string> = {
  WORKING_DAYS: 'Working days',
  WEEKS: 'Weeks',
  MONTHS: 'Months',
  FIXED_DEADLINE: 'Fixed client deadline',
};

function initialTimeline(project: ProjectResponse): Timeline {
  return project.timeline ?? { mode: 'WEEKS', weeks: 12 };
}

/**
 * The delivery timeline — the one mandatory planning input.
 *
 * The modes are mutually exclusive in the UI as well as the contract: switching
 * mode replaces the value rather than accumulating fields, so there is never a
 * form state that could submit two.
 */
export function TimelineSection({ project }: { project: ProjectResponse }) {
  const [timeline, setTimeline] = useState<Timeline>(() => initialTimeline(project));
  const [error, setError] = useState<string | undefined>();

  const { save, state, message } = useSectionSave<{ timeline: Timeline }>({
    mutate: updateTimeline,
  });

  function changeMode(mode: TimelineMode) {
    setError(undefined);

    switch (mode) {
      case 'WORKING_DAYS':
        setTimeline({ mode, workingDays: 30 });
        break;
      case 'WEEKS':
        setTimeline({ mode, weeks: 12 });
        break;
      case 'MONTHS':
        setTimeline({ mode, months: 3 });
        break;
      case 'FIXED_DEADLINE':
        setTimeline({ mode, deadline: defaultDeadline() });
        break;
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Delivery timeline</CardTitle>
            <CardDescription>
              Required. Your timeline is authoritative — it is never silently extended. If it is
              tight, later steps show the staffing and risk it implies rather than moving the date.
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
            setError(undefined);
            save({ timeline });
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">How is the timeline expressed?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(MODE_LABELS) as TimelineMode[]).map((mode) => (
                <label
                  key={mode}
                  className={`flex items-center gap-2.5 rounded-md border p-2.5 text-sm ${
                    timeline.mode === mode ? 'border-accent bg-accent-soft' : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="timeline-mode"
                    value={mode}
                    checked={timeline.mode === mode}
                    onChange={() => changeMode(mode)}
                    className="size-4"
                  />
                  {MODE_LABELS[mode]}
                </label>
              ))}
            </div>
          </fieldset>

          {timeline.mode === 'WORKING_DAYS' ? (
            <Field label="Working days" required error={error}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={TIMELINE_LIMITS.workingDays.min}
                  max={TIMELINE_LIMITS.workingDays.max}
                  value={timeline.workingDays}
                  onChange={(event) =>
                    setTimeline({ mode: 'WORKING_DAYS', workingDays: Number(event.target.value) })
                  }
                />
              )}
            </Field>
          ) : null}

          {timeline.mode === 'WEEKS' ? (
            <Field label="Weeks" required error={error}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={TIMELINE_LIMITS.weeks.min}
                  max={TIMELINE_LIMITS.weeks.max}
                  value={timeline.weeks}
                  onChange={(event) =>
                    setTimeline({ mode: 'WEEKS', weeks: Number(event.target.value) })
                  }
                />
              )}
            </Field>
          ) : null}

          {timeline.mode === 'MONTHS' ? (
            <Field label="Months" required error={error}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={TIMELINE_LIMITS.months.min}
                  max={TIMELINE_LIMITS.months.max}
                  value={timeline.months}
                  onChange={(event) =>
                    setTimeline({ mode: 'MONTHS', months: Number(event.target.value) })
                  }
                />
              )}
            </Field>
          ) : null}

          {timeline.mode === 'FIXED_DEADLINE' ? (
            <Field label="Client delivery deadline" required error={error}>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  value={timeline.deadline}
                  onChange={(event) =>
                    setTimeline({ mode: 'FIXED_DEADLINE', deadline: event.target.value })
                  }
                />
              )}
            </Field>
          ) : null}

          <Button type="submit" disabled={state === 'saving'} className="self-start">
            {state === 'saving' ? 'Saving…' : 'Save timeline'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function defaultDeadline(): string {
  return new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
}
