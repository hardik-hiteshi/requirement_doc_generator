'use client';

import {
  FEASIBILITY_LABELS,
  feasibilityNeedsAcknowledgement,
  type EstimateSnapshot,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useAcknowledgeTimelineRisk } from '@/hooks/use-estimation';

/**
 * Whether the work fits the time the user asked for.
 *
 * The panel that does not soften. The requested timeline appears next to what
 * the plan needs, with the gap stated in the units it is actually in — hours
 * short, or working days over — and then four options, all of which are the
 * user's.
 *
 * Acknowledging is not agreeing that the deadline is fine. It is recording that
 * they have read this and are proceeding, which is the only thing that clears
 * the blocker. The plan does not change.
 */
export function FeasibilityPanel({ estimate }: { readonly estimate: EstimateSnapshot }) {
  const acknowledge = useAcknowledgeTimelineRisk();
  const [note, setNote] = useState('');

  const feasibility = estimate.feasibility;
  const needsAcknowledgement = feasibilityNeedsAcknowledgement(feasibility.status);
  const alreadyAcknowledged = estimate.riskAcknowledgedStatus === feasibility.status;

  return (
    <Card role="region" aria-label="Delivery feasibility">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Will it fit?</CardTitle>
          <Badge tone={toneFor(feasibility.status)} data-testid="feasibility-status">
            {FEASIBILITY_LABELS[feasibility.status]}
          </Badge>
        </div>
        <CardDescription>
          Measured against the timeline you set. That timeline has not been changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm" data-testid="feasibility-reason">
          {feasibility.reason}
        </p>

        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Work needs</dt>
            <dd>{feasibility.requiredWorkingDays} working days</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">You allowed</dt>
            <dd>
              {feasibility.availableWorkingDays === null
                ? 'Needs a start date'
                : `${feasibility.availableWorkingDays} working days`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Hours needed</dt>
            <dd>{Math.round(feasibility.requiredHours).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Hours short</dt>
            <dd data-testid="capacity-gap">
              {feasibility.capacityGapHours > 0
                ? Math.round(feasibility.capacityGapHours).toLocaleString()
                : 'None'}
            </dd>
          </div>
        </dl>

        {feasibility.risks.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium">What to watch</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {feasibility.risks.map((risk) => (
                <li
                  key={risk.kind + risk.subjects.join()}
                  className="rounded-md border border-border p-3 text-sm"
                  data-testid={`risk-${risk.kind}`}
                >
                  <p>{risk.summary}</p>
                  <p className="mt-1 text-xs text-muted">{risk.suggestion}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {needsAcknowledgement ? (
          alreadyAcknowledged ? (
            <p className="text-xs text-muted">
              You read this and chose to proceed. It stays on the record and goes into the
              documents.
            </p>
          ) : (
            <form
              className="flex flex-col gap-2 rounded-md border border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                acknowledge.mutate({
                  acknowledged: true,
                  ...(note.trim() ? { note: note.trim() } : {}),
                  expectedVersion: estimate.recordVersion,
                });
              }}
            >
              <p className="text-sm">
                You can proceed with this timeline. Nothing here changes it — this records that you
                have read it.
              </p>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Anything to record about the decision?</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="rounded-md border border-border px-2 py-1 text-sm"
                />
              </label>
              <Button type="submit" className="self-start" disabled={acknowledge.isPending}>
                I have read this and I am proceeding
              </Button>
              {acknowledge.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {acknowledge.error.message}
                </p>
              ) : null}
            </form>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function toneFor(
  status: EstimateSnapshot['feasibility']['status'],
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'COMFORTABLE' || status === 'FEASIBLE') {
    return 'success';
  }

  if (status === 'AGGRESSIVE') {
    return 'warning';
  }

  if (status === 'HIGH_RISK' || status === 'NOT_FEASIBLE_WITH_CURRENT_CAPACITY') {
    return 'danger';
  }

  return 'neutral';
}
