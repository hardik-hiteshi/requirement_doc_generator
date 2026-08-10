'use client';

import {
  ESTIMATION_ROLE_LABELS,
  SUSTAINABLE_UTILISATION,
  isStandardRole,
  type EstimateSnapshot,
} from '@wdrg/contracts';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

/**
 * Hours available, and whether they cover the hours needed.
 *
 * The middle panel, and the one that stops the screen inviting a division.
 * Without it a reader goes from "1,250 hours" to "eight weeks" on their own,
 * which is only true if somebody worked out who is doing it.
 *
 * When no team has been supplied it shows the recommended one instead — which
 * is the right answer to "how many people would this take?", and is fractional
 * where a fraction is honest.
 */
export function CapacityPanel({ estimate }: { readonly estimate: EstimateSnapshot }) {
  const teamSupplied = estimate.team.supplied;

  if (estimate.utilisation.length === 0 && estimate.recommendedStaffing.length === 0) {
    return null;
  }

  return (
    <Card role="region" aria-label="Capacity">
      <CardHeader>
        <CardTitle>Capacity</CardTitle>
        <CardDescription>
          {teamSupplied
            ? 'What your team can supply in the time you have asked for.'
            : 'You have not told us who is on the team, so here is what this plan would need.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {teamSupplied ? (
          <ul className="flex flex-col gap-2">
            {estimate.utilisation
              .filter((line) => line.plannedHours > 0 || line.availableHours > 0)
              .map((line) => (
                <li
                  key={line.role}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                  data-testid={`utilisation-${line.role}`}
                >
                  <span>
                    {isStandardRole(line.role) ? ESTIMATION_ROLE_LABELS[line.role] : line.role}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted">
                      {Math.round(line.plannedHours)} h needed of {Math.round(line.availableHours)}{' '}
                      h available
                    </span>
                    {line.gapHours > 0 ? (
                      <Badge tone="danger">{Math.round(line.gapHours)} h short</Badge>
                    ) : line.utilisation > SUSTAINABLE_UTILISATION ? (
                      <Badge tone="warning">{Math.round(line.utilisation * 100)}% loaded</Badge>
                    ) : (
                      <Badge tone="success">{Math.round(line.utilisation * 100)}% loaded</Badge>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <ul className="flex flex-col gap-2">
            {estimate.recommendedStaffing.map((line) => (
              <li
                key={line.role}
                className="rounded-md border border-border p-3 text-sm"
                data-testid={`staffing-${line.role}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {isStandardRole(line.role) ? ESTIMATION_ROLE_LABELS[line.role] : line.role}
                  </span>
                  <span className="text-muted">
                    {line.people} {line.people === 1 ? 'person' : 'people'} ·{' '}
                    {Math.round(line.hours)} h
                  </span>
                </div>
                {/*
                  "0.3 DevOps engineers" is a real answer that reads as an
                  error. The note is what stops a reader rounding it up.
                */}
                <p className="mt-1 text-xs text-muted">{line.note}</p>
              </li>
            ))}
          </ul>
        )}

        {estimate.utilisation.some((line) => line.gapHours > 0) ? (
          <p className="text-xs text-muted">
            A shortfall is not a reason to move your deadline — it is one of four things you can
            change. The others are the team, the scope, and accepting the risk.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
