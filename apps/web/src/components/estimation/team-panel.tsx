'use client';

import { useState } from 'react';
import {
  ESTIMATION_ROLE_LABELS,
  isStandardRole,
  type CapacityLine,
  type EstimateSnapshot,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { useSetTeam } from '@/hooks/use-estimation';

/**
 * Who is actually available, if the user knows yet.
 *
 * ## Optional, and it has to stay optional
 *
 * A plan with no team is a complete answer to "what would this take?" — the
 * capacity panel shows the staffing the work would need, and the schedule is laid
 * out against that derived capacity. Nobody has to invent a team to get a date.
 *
 * So this panel starts empty and says so. What it offers is the other question:
 * "here is who we actually have — does it still fit?" Answering that turns
 * recommended staffing into measured utilisation, and feasibility from a
 * projection into an assessment.
 *
 * ## Why every field is here
 *
 * Each one changes the arithmetic, and each is already in Phase 6's capacity
 * model. People and hours give available hours. Days a week and availability
 * scale them — somebody at 60% is on this project three days in five, and
 * pretending otherwise is how a plan that looked fine stops fitting. The
 * available-from day is what makes a late-joining role show as a bottleneck
 * rather than as a surprise.
 *
 * Roles come from the priced estimate, which is what stops somebody staffing a
 * role this project has no work for — the API refuses that, and offering it would
 * be offering a dead end.
 */
export function TeamPanel({ estimate }: { readonly estimate: EstimateSnapshot }) {
  const setTeam = useSetTeam();

  const [lines, setLines] = useState<readonly CapacityLine[] | null>(null);
  const editing = lines !== null;

  /* Roles the estimate priced. Staffing anything else is refused, rightly. */
  const roles = [
    ...new Set([
      ...Object.entries(estimate.effortByRole)
        .filter(([, hours]) => hours > 0)
        .map(([role]) => role),
      ...estimate.team.lines.map((line) => line.role),
    ]),
  ].sort();

  const labelFor = (role: string): string =>
    isStandardRole(role) ? ESTIMATION_ROLE_LABELS[role] : role;

  /** Start from what is there, or from the recommendation where there is none. */
  const startEditing = (): void => {
    if (estimate.team.lines.length > 0) {
      setLines(estimate.team.lines.map((line) => ({ ...line })));

      return;
    }

    setLines(
      roles.map((role) => {
        const recommended = estimate.recommendedStaffing.find((line) => line.role === role);

        return {
          role,
          /*
           * The recommendation as it stands, fraction intact.
           *
           * Rounding 0.3 up to 1 here would seed the form with three and a half days
           * a week of somebody's time that nobody offered, and the user would very
           * reasonably accept it. Phase 6's capacity model is fractional throughout,
           * and this is a starting point they can change rather than a claim about
           * who exists.
           */
          people: recommended?.people ?? 1,
          productiveHoursPerDay: estimate.calendar.hoursPerDay,
          workingDaysPerWeek: estimate.calendar.workingWeekdays.length,
          availability: 1,
          availableFromDay: 0,
        };
      }),
    );
  };

  const update = (role: string, changes: Partial<CapacityLine>): void => {
    setLines((current) =>
      (current ?? []).map((line) => (line.role === role ? { ...line, ...changes } : line)),
    );
  };

  const save = (next: readonly CapacityLine[]): void => {
    void setTeam
      .mutateAsync({ lines: [...next], expectedVersion: estimate.recordVersion })
      .then(() => setLines(null));
  };

  return (
    <Card role="region" aria-label="Team">
      <CardHeader>
        <CardTitle>Your team</CardTitle>
        <CardDescription>
          Optional. Without it this plan shows the staffing the work would need; with it, the
          schedule and feasibility are measured against who you actually have.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!estimate.team.supplied && !editing ? (
          <p className="text-sm" data-testid="team-not-supplied">
            No team supplied. The capacity below is what this plan would need, and the schedule is
            laid out against it — you do not have to invent a team to get a date.
          </p>
        ) : null}

        {estimate.team.supplied && !editing ? (
          <ul className="flex flex-col gap-2" data-testid="team-summary">
            {estimate.team.lines.map((line) => (
              <li
                key={line.role}
                className="rounded-md border border-border p-3 text-sm"
                data-testid={`team-line-${line.role}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{labelFor(line.role)}</span>
                  <span className="text-muted">
                    {line.people} {line.people === 1 ? 'person' : 'people'} ·{' '}
                    {line.productiveHoursPerDay} h/day · {line.workingDaysPerWeek} days/week ·{' '}
                    {Math.round(line.availability * 100)}% available
                    {line.availableFromDay > 0 ? ` · from day ${line.availableFromDay}` : ''}
                  </span>
                </div>
                {line.note ? <p className="mt-1 text-xs text-muted">{line.note}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {editing ? (
          <div className="flex flex-col gap-3">
            {(lines ?? []).map((line) => (
              <fieldset
                key={line.role}
                className="flex flex-col gap-2 rounded-md border border-border p-3"
                data-testid={`team-edit-${line.role}`}
              >
                <legend className="px-1 text-sm font-medium">{labelFor(line.role)}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs">
                    People
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      className="rounded-md border border-border bg-surface p-2 text-sm"
                      value={line.people}
                      onChange={(event) =>
                        update(line.role, { people: Number(event.target.value) })
                      }
                      data-testid={`team-people-${line.role}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Productive hours a day
                    <input
                      type="number"
                      min={0}
                      max={24}
                      step={0.5}
                      className="rounded-md border border-border bg-surface p-2 text-sm"
                      value={line.productiveHoursPerDay}
                      onChange={(event) =>
                        update(line.role, { productiveHoursPerDay: Number(event.target.value) })
                      }
                      data-testid={`team-hours-${line.role}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Working days a week
                    <input
                      type="number"
                      min={1}
                      max={7}
                      className="rounded-md border border-border bg-surface p-2 text-sm"
                      value={line.workingDaysPerWeek}
                      onChange={(event) =>
                        update(line.role, { workingDaysPerWeek: Number(event.target.value) })
                      }
                      data-testid={`team-days-${line.role}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Availability (%)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="rounded-md border border-border bg-surface p-2 text-sm"
                      value={Math.round(line.availability * 100)}
                      onChange={(event) =>
                        update(line.role, {
                          availability: Math.min(1, Math.max(0, Number(event.target.value) / 100)),
                        })
                      }
                      data-testid={`team-availability-${line.role}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Available from working day
                    <input
                      type="number"
                      min={0}
                      className="rounded-md border border-border bg-surface p-2 text-sm"
                      value={line.availableFromDay}
                      onChange={(event) =>
                        update(line.role, { availableFromDay: Number(event.target.value) })
                      }
                      data-testid={`team-from-${line.role}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Note
                    <input
                      className="rounded-md border border-border bg-surface p-2 text-sm"
                      value={line.note ?? ''}
                      onChange={(event) => update(line.role, { note: event.target.value })}
                      data-testid={`team-note-${line.role}`}
                    />
                  </label>
                </div>
              </fieldset>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={setTeam.isPending}
                data-testid="team-save"
                onClick={() => save(lines ?? [])}
              >
                Use this team
              </Button>
              <Button variant="secondary" onClick={() => setLines(null)} data-testid="team-cancel">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={startEditing} data-testid="team-edit">
              {estimate.team.supplied ? 'Change the team' : 'Tell us who is on the team'}
            </Button>
            {estimate.team.supplied ? (
              <Button
                variant="secondary"
                disabled={setTeam.isPending}
                data-testid="team-remove"
                onClick={() => save([])}
              >
                Remove the team
              </Button>
            ) : null}
          </div>
        )}

        {setTeam.isError ? (
          <p role="alert" className="text-sm text-danger" data-testid="team-error">
            {setTeam.error.message}
          </p>
        ) : null}

        {estimate.status === 'APPROVED' ? (
          <Badge tone="warning" data-testid="team-approved-warning">
            Changing the team reopens this estimate for approval
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  );
}
