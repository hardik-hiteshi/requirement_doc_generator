'use client';

import {
  EFFORT_RANGE_LABELS,
  ESTIMATION_ROLE_LABELS,
  isStandardRole,
  type EstimateSnapshot,
} from '@wdrg/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

/**
 * Hours of work. Not weeks, and not a date.
 *
 * The first of three panels, and the only one on the screen that is purely a
 * property of the work itself: it does not change when the team changes, and it
 * does not change when the start date moves.
 *
 * The range is shown beside the number rather than behind a disclosure, because
 * the range is the honest content of an estimate. A single figure presented on
 * its own reads as a measurement.
 */
export function EffortPanel({ estimate }: { readonly estimate: EstimateSnapshot }) {
  const roles = Object.entries(estimate.effortByRole)
    .filter(([, hours]) => hours > 0)
    .sort(([, first], [, second]) => second - first);

  if (roles.length === 0) {
    return null;
  }

  return (
    <Card role="region" aria-label="Effort">
      <CardHeader>
        <CardTitle>Effort</CardTitle>
        <CardDescription>
          Hours of work. How long that takes depends on who does it and what waits for what — see
          below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          {(['optimistic', 'expected', 'conservative'] as const).map((band) => (
            <div key={band} className="rounded-md border border-border p-3">
              <dt className="text-xs text-muted">{EFFORT_RANGE_LABELS[band]}</dt>
              <dd className="text-lg font-medium" data-testid={`effort-${band}`}>
                {Math.round(estimate.totalEffort[band]).toLocaleString()} hours
              </dd>
            </div>
          ))}
        </dl>

        <p className="text-xs text-muted">
          Planning uses the expected figure. The spread comes from how much is known about each
          item, not from a flat percentage.
        </p>

        <div>
          <h3 className="text-sm font-medium">By role</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {roles.map(([role, hours]) => (
              <li key={role} className="flex items-center justify-between gap-2">
                <span>{isStandardRole(role) ? ESTIMATION_ROLE_LABELS[role] : role}</span>
                <span className="text-muted">{Math.round(hours).toLocaleString()} h</span>
              </li>
            ))}
          </ul>
        </div>

        {/*
          Named rather than folded into a percentage, so a reader can see what
          each is and disagree with one of them.
        */}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Building things</dt>
            <dd>{Math.round(estimate.implementationHours).toLocaleString()} hours</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">
              Everything else — setup, review, regression, coordination, release
            </dt>
            <dd>{Math.round(estimate.overheadHours).toLocaleString()} hours</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
