'use client';

import {
  COMPLEXITY_LABELS,
  ESTIMATE_SOURCE_LABELS,
  ESTIMATION_ROLE_LABELS,
  TASK_CATEGORY_LABELS,
  UNCERTAINTY_LABELS,
  isStandardRole,
  isUserAuthored,
  type EstimateSnapshot,
  type EstimateUnit,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useOverrideEstimate, useResetEstimate } from '@/hooks/use-estimation';

/**
 * Every line, what it costs, and why.
 *
 * The row is where override authority becomes visible. A figure the application
 * calculated says "Calculated" and offers an edit. A figure a person set says
 * "Your figure", shows what it was before, and offers a reset — and a later
 * re-estimation leaves it exactly where it is.
 *
 * Complexity and uncertainty are shown apart, because they are different claims
 * and conflating them is how a well-understood hard feature and a simple unknown
 * one end up looking the same.
 */
export function EstimateTable({
  estimate,
  applicableRoles,
}: {
  readonly estimate: EstimateSnapshot;
  readonly applicableRoles: readonly string[];
}) {
  if (estimate.estimates.length === 0) {
    return null;
  }

  const features = estimate.estimates.filter((unit) => !unit.overheadActivity);
  const overhead = estimate.estimates.filter((unit) => unit.overheadActivity);

  return (
    <Card role="region" aria-label="Estimate lines">
      <CardHeader>
        <CardTitle>What was estimated</CardTitle>
        <CardDescription>
          Change any figure. Yours is authoritative from then on, and re-estimating leaves it alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {features.map((unit) => (
            <li key={unit.id}>
              <EstimateRow unit={unit} estimate={estimate} applicableRoles={applicableRoles} />
            </li>
          ))}
        </ul>

        {overhead.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Delivery overhead ({overhead.length})
            </summary>
            <p className="mt-1 text-xs text-muted">
              Real work that is not a feature: setup, review, regression, coordination, release.
              Named rather than added as a percentage, so you can disagree with one of them.
            </p>
            <ul className="mt-2 flex flex-col gap-3">
              {overhead.map((unit) => (
                <li key={unit.id}>
                  <EstimateRow unit={unit} estimate={estimate} applicableRoles={applicableRoles} />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EstimateRow({
  unit,
  estimate,
  applicableRoles,
}: {
  readonly unit: EstimateUnit;
  readonly estimate: EstimateSnapshot;
  readonly applicableRoles: readonly string[];
}) {
  const override = useOverrideEstimate();
  const reset = useResetEstimate();
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');

  const roles = Object.entries(unit.effort).filter(([, value]) => value > 0);
  const locked = estimate.status === 'APPROVED';

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid={`estimate-${unit.key}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            <span className="text-muted">{unit.key}</span> {unit.feature}
          </p>
          <p className="text-xs text-muted">{TASK_CATEGORY_LABELS[unit.taskCategory]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isUserAuthored(unit.source) ? 'success' : 'neutral'}>
            {ESTIMATE_SOURCE_LABELS[unit.source]}
          </Badge>
          <span className="text-sm font-medium" data-testid={`hours-${unit.key}`}>
            {Math.round(unit.totalHours)} h
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="neutral">{COMPLEXITY_LABELS[unit.complexity]}</Badge>
        <Badge tone={unit.uncertainty === 'HIGH' ? 'warning' : 'neutral'}>
          {UNCERTAINTY_LABELS[unit.uncertainty]}
        </Badge>
        <span className="text-muted">
          {Math.round(unit.range.optimistic)}–{Math.round(unit.range.conservative)} h
        </span>
      </div>

      <p className="text-xs text-muted">{unit.complexityExplanation}</p>
      {unit.uncertainty !== 'LOW' ? (
        <p className="text-xs text-muted">{unit.uncertaintyExplanation}</p>
      ) : null}

      {roles.length > 0 ? (
        <ul className="flex flex-wrap gap-3 text-xs">
          {roles.map(([role, value]) => (
            <li key={role}>
              <span className="text-muted">
                {isStandardRole(role) ? ESTIMATION_ROLE_LABELS[role] : role}
              </span>{' '}
              {Math.round(value)} h
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Every driver names a technology from the locked stack, which is what
        makes "two native platforms cost more" checkable rather than an opinion
        — and what shows the stack being priced rather than second-guessed.
      */}
      {unit.drivers.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {unit.drivers.map((driver, index) => (
            <li key={`${driver.kind}-${index}`}>
              {driver.summary}
              {driver.additionalHours ? ` (+${Math.round(driver.additionalHours)} h)` : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {unit.originalTotalHours !== undefined ? (
        <p className="text-xs text-muted">
          Was {Math.round(unit.originalTotalHours)} h before you changed it
          {unit.overrideNote ? `: ${unit.overrideNote}` : '.'}
        </p>
      ) : null}

      {!locked ? (
        editing ? (
          /*
           * A div with an explicit button rather than a form. This row sits
           * inside a list that is itself inside a disclosure, and a nested
           * submit is one layout change away from being swallowed — an override
           * that silently does nothing is the worst outcome on this screen.
           */
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {applicableRoles.map((role) => (
                <label key={role} className="flex flex-col gap-1 text-xs">
                  <span className="font-medium">
                    {isStandardRole(role) ? ESTIMATION_ROLE_LABELS[role] : role}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    data-testid={`hours-input-${role}`}
                    value={hours[role] ?? String(unit.effort[role] ?? '')}
                    onChange={(event) =>
                      setHours((was) => ({ ...was, [role]: event.target.value }))
                    }
                    className="w-24 rounded-md border border-border px-2 py-1 text-sm"
                  />
                </label>
              ))}
            </div>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Why?</span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="rounded-md border border-border px-2 py-1 text-sm"
              />
            </label>
            <div className="flex gap-2">
              <Button
                disabled={override.isPending}
                onClick={() => {
                  const effort = Object.fromEntries(
                    Object.entries(hours)
                      .filter(([, value]) => value.trim() !== '')
                      .map(([role, value]) => [role, Number(value)]),
                  );

                  override.mutate(
                    {
                      estimateId: unit.id,
                      request: {
                        effort,
                        ...(note.trim() ? { note: note.trim() } : {}),
                        expectedVersion: estimate.recordVersion,
                      },
                    },
                    { onSuccess: () => setEditing(false) },
                  );
                }}
              >
                Save my figure
              </Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
            {override.isError ? (
              <p role="alert" className="text-xs text-danger">
                {override.error.message}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Change this figure
            </Button>
            {unit.originalTotalHours !== undefined ? (
              <Button
                variant="secondary"
                onClick={() =>
                  reset.mutate({ estimateId: unit.id, expectedVersion: estimate.recordVersion })
                }
                disabled={reset.isPending}
              >
                Back to the calculated figure
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
