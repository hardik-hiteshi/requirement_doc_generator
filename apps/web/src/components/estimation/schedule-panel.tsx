'use client';

import { DEPENDENCY_TYPE_LABELS, type EstimateSnapshot } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useRecalculateSchedule, useRemoveDependency } from '@/hooks/use-estimation';

/**
 * Elapsed time, and where it comes from.
 *
 * The third panel. It shows working days and — only when the project has a
 * start date — actual dates. A project with no start date gets Day 1, Day 12,
 * Week 3, and that is a complete answer rather than a degraded one: nothing here
 * invents a calendar the user did not supply.
 *
 * The critical path is marked because it is the answer to "why is it this long?"
 * — and because it is what tells a reader which tasks slipping actually moves
 * the finish.
 */
export function SchedulePanel({ estimate }: { readonly estimate: EstimateSnapshot }) {
  const recalculate = useRecalculateSchedule();
  const removeDependency = useRemoveDependency();
  const [showAll, setShowAll] = useState(false);

  const schedule = estimate.schedule;

  if (schedule.tasks.length === 0) {
    return null;
  }

  const byId = new Map(estimate.estimates.map((unit) => [unit.id, unit]));
  const shown = showAll ? schedule.tasks : schedule.tasks.filter((task) => task.onCriticalPath);

  return (
    <Card role="region" aria-label="Schedule">
      <CardHeader>
        <CardTitle>Schedule</CardTitle>
        <CardDescription>
          {schedule.relativeOnly
            ? 'Working days from the start. Set a start date in project details and these become real dates.'
            : `From ${schedule.startDate} to ${schedule.finishDate}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Working days</dt>
            <dd className="text-lg font-medium" data-testid="schedule-days">
              {schedule.totalWorkingDays}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">On the critical path</dt>
            <dd>{schedule.criticalPath.length} tasks</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Dates</dt>
            <dd data-testid="schedule-mode">
              {schedule.relativeOnly ? 'Relative to the start' : 'Actual'}
            </dd>
          </div>
        </dl>

        {/*
          The one operation that recalculates dates and nothing else. Effort,
          complexity, overrides and the dependency graph are untouched — which
          is what makes moving a start date safe.
        */}
        {!schedule.relativeOnly && estimate.status !== 'APPROVED' ? (
          <div className="flex flex-col gap-1">
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => recalculate.mutate(estimate.recordVersion)}
              disabled={recalculate.isPending}
            >
              Recalculate the dates
            </Button>
            <p className="text-xs text-muted">
              Moves the dates to match the current start date. The hours, the complexity, your
              overrides and what waits for what are all untouched.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            {showAll ? 'Every task' : 'What is setting the length'}
          </h3>
          <button
            type="button"
            className="text-xs underline"
            onClick={() => setShowAll((was) => !was)}
          >
            {showAll ? 'Show only the critical path' : 'Show every task'}
          </button>
        </div>

        <ul className="flex flex-col gap-2">
          {shown.slice(0, 60).map((task) => {
            const unit = byId.get(task.taskId);

            return (
              <li
                key={task.taskId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  {task.onCriticalPath ? <Badge tone="warning">Critical</Badge> : null}
                  <span>{unit?.feature ?? task.taskId}</span>
                </span>
                <span className="text-xs text-muted">
                  {task.startDate
                    ? `${task.startDate} → ${task.endDate}`
                    : `Day ${task.startDay} → ${task.endDay}`}
                  {task.slackDays > 0 ? ` · ${task.slackDays} days of slack` : ''}
                </span>
              </li>
            );
          })}
        </ul>

        {estimate.dependencies.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs">
              What waits for what ({estimate.dependencies.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {estimate.dependencies.slice(0, 60).map((dependency) => (
                <li key={dependency.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span>
                    <span className="font-medium">
                      {byId.get(dependency.predecessorId)?.feature ?? dependency.predecessorId}
                    </span>{' '}
                    {DEPENDENCY_TYPE_LABELS[dependency.type]}{' '}
                    <span className="font-medium">
                      {byId.get(dependency.successorId)?.feature ?? dependency.successorId}
                    </span>
                  </span>
                  {dependency.userDefined && estimate.status !== 'APPROVED' ? (
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        removeDependency.mutate({
                          dependencyId: dependency.id,
                          expectedVersion: estimate.recordVersion,
                        })
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {estimate.milestones.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium">Milestones</h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {estimate.milestones.map((milestone) => (
                <li key={milestone.id} className="flex items-center justify-between gap-2">
                  <span>{milestone.label}</span>
                  <span className="text-xs text-muted">
                    {milestone.date ?? `Day ${milestone.day}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
