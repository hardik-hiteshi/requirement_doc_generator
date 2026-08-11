'use client';

import {
  DEFAULT_PRODUCTIVE_HOURS_NOTE,
  ESTIMATE_NOTICE,
  ESTIMATE_STATUS_LABELS,
  FEASIBILITY_LABELS,
  PRODUCTIVITY_MODEL_SUMMARY,
  type EstimateSnapshot,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useApproveEstimate,
  useEstimate,
  useEstimationRun,
  useReopenEstimate,
  useRunEstimation,
} from '@/hooks/use-estimation';
import { EffortPanel } from './effort-panel';
import { FeasibilityPanel } from './feasibility-panel';
import { CalendarPanel } from './calendar-panel';
import { CapacityPanel } from './capacity-panel';
import { TeamPanel } from './team-panel';
import { SchedulePanel } from './schedule-panel';
import { EstimateTable } from './estimate-table';

/**
 * Effort, capacity and the delivery timeline.
 *
 * The screen is arranged around the distinction the whole phase rests on, and
 * it makes it visible rather than assuming the reader knows it:
 *
 * **Effort** is hours of work. **Capacity** is hours available. **Duration** is
 * elapsed time, and it comes from the two of them plus what has to wait for
 * what. They are three separate panels, in that order, because a reader who
 * sees "1,250 hours" and then "8 weeks" without the middle step has been
 * invited to divide one by the other.
 *
 * The other thing the screen refuses to do is soften the answer. Where the work
 * does not fit the timeline the user set, it says so, says by how much, says
 * what would close the gap — and leaves the decision with them.
 */
export function EstimationStep() {
  const { data, isPending, isError } = useEstimate();
  const { data: runView } = useEstimationRun();
  const run = useRunEstimation();
  const approve = useApproveEstimate();
  const reopen = useReopenEstimate();
  const [acknowledged, setAcknowledged] = useState(false);

  if (isPending) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted">Loading the estimate…</p>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-danger">
            The estimate could not be loaded. Reload the page to try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  const estimate = data.snapshot;
  const isApproved = estimate.status === 'APPROVED';
  const blocked = estimate.blockers.length > 0;

  return (
    <section
      aria-label="Estimation and timeline"
      role="region"
      className="flex flex-col gap-4"
      data-testid="estimation"
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Estimation &amp; timeline</CardTitle>
            <div className="flex items-center gap-2">
              <Badge tone={toneFor(estimate.status)} data-testid="estimate-status">
                {ESTIMATE_STATUS_LABELS[estimate.status]}
              </Badge>
              <span className="text-xs text-muted">Estimate v{estimate.version}</span>
            </div>
          </div>
          <CardDescription>{ESTIMATE_NOTICE}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Requirements</dt>
              <dd>
                {estimate.baselineVersion
                  ? `Baseline v${estimate.baselineVersion}`
                  : 'Not approved'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Technologies</dt>
              <dd>{estimate.stackVersion ? `Stack v${estimate.stackVersion}` : 'Not locked'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">You asked for</dt>
              <dd data-testid="required-timeline">{estimate.timelineDescription}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Starting</dt>
              <dd>{estimate.startDate ?? 'Not set — dates are relative'}</dd>
            </div>
          </dl>

          {estimate.status === 'OUTDATED' ? (
            <p role="status" className="rounded-md bg-warning-subtle p-3 text-sm">
              Something upstream changed after this estimate was made. Nothing in it has been
              altered — review it and approve again when you are satisfied.
            </p>
          ) : null}

          {isApproved ? (
            <ReopenNotice
              onReopen={(reason) =>
                reopen.mutate({ reason, expectedVersion: estimate.recordVersion })
              }
              pending={reopen.isPending}
              error={reopen.isError ? reopen.error.message : undefined}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">Estimate the work</h3>
                  <p className="text-xs text-muted">
                    Every approved requirement gets a line. Anything you have set yourself is left
                    exactly as you set it.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() =>
                      run.mutate({ useAi: false, expectedVersion: estimate.recordVersion })
                    }
                    disabled={run.isPending || blockedUpstream(estimate)}
                    variant="secondary"
                  >
                    {run.isPending ? 'Working…' : 'Estimate without AI'}
                  </Button>
                  <Button
                    onClick={() =>
                      run.mutate({ useAi: true, expectedVersion: estimate.recordVersion })
                    }
                    disabled={
                      run.isPending || runView?.configured === false || blockedUpstream(estimate)
                    }
                  >
                    {run.isPending ? 'Working…' : 'Estimate with AI'}
                  </Button>
                </div>
              </div>

              {/*
                The manual-mode promise, stated where it matters. A deployment
                with no inference server is not degraded here — it simply uses
                the other button.
              */}
              {runView?.configured === false ? (
                <p role="status" className="text-xs text-muted">
                  AI assessment is not switched on for this deployment. Estimating without it uses
                  the same rules and produces a complete plan.
                </p>
              ) : null}

              {run.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {run.error.message}
                </p>
              ) : null}

              <details className="text-xs text-muted">
                <summary className="cursor-pointer">What these numbers assume</summary>
                <p className="mt-2">{PRODUCTIVITY_MODEL_SUMMARY}</p>
                <p className="mt-2">{DEFAULT_PRODUCTIVE_HOURS_NOTE}</p>
                <p className="mt-2">
                  Methodology {estimate.productivityModelVersion}. This is recorded internally and
                  does not appear in anything the client sees unless you turn it on.
                </p>
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      {/*
        The three panels, in the order that keeps them distinct. A reader who
        goes straight from hours to dates has skipped the step that decides
        whether the division is even meaningful.
      */}
      <EffortPanel estimate={estimate} />
      <CapacityPanel estimate={estimate} />
      {/*
       * The two inputs behind every duration on this screen. They sit after
       * capacity because that is the order a reader needs them in: what the plan
       * would take, then who is available and on what calendar.
       */}
      <TeamPanel estimate={estimate} />
      <CalendarPanel estimate={estimate} />
      <SchedulePanel estimate={estimate} />
      <FeasibilityPanel estimate={estimate} />

      <EstimateTable estimate={estimate} applicableRoles={data.applicableRoles} />

      <Card>
        <CardHeader>
          <CardTitle>Approve the estimate</CardTitle>
          <CardDescription>
            Approving does not require the deadline to be achievable — it requires you to have read
            what it says.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {blocked ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Before you can approve</h3>
              <ul className="flex flex-col gap-2">
                {estimate.blockers.map((blocker) => (
                  <li key={blocker.kind} className="rounded-md border border-border p-3 text-sm">
                    <p className="font-medium">{blocker.summary}</p>
                    <p className="text-xs text-muted">{blocker.action}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {isApproved ? (
            <p className="text-sm">
              Approved{estimate.approvedAt ? ` on ${formatDate(estimate.approvedAt)}` : ''}, with
              the timeline recorded as{' '}
              {FEASIBILITY_LABELS[estimate.feasibility.status].toLowerCase()}.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I have read this estimate and I am accountable for it, whether the AI assessed the
                  requirements or I did.
                </span>
              </label>
              <Button
                className="self-start"
                disabled={blocked || !acknowledged || approve.isPending}
                onClick={() =>
                  approve.mutate({
                    acknowledgedAiAssistance: true,
                    expectedVersion: estimate.recordVersion,
                  })
                }
              >
                Approve this estimate
              </Button>
              {approve.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {approve.error.message}
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** True when the estimate cannot be produced at all yet. */
function blockedUpstream(estimate: EstimateSnapshot): boolean {
  return estimate.blockers.some(
    (blocker) =>
      blocker.kind === 'baseline_not_approved' ||
      blocker.kind === 'stack_not_locked' ||
      blocker.kind === 'timeline_missing',
  );
}

function ReopenNotice({
  onReopen,
  pending,
  error,
}: {
  readonly onReopen: (reason: string) => void;
  readonly pending: boolean;
  readonly error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <p className="text-sm">
        This estimate is approved. Reopening keeps it exactly as it is and starts a new version.
      </p>

      {open ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();

            if (reason.trim()) {
              onReopen(reason.trim());
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Why are you reopening it?</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              className="rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !reason.trim()}>
              Reopen the estimate
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
          Reopen and change it
        </Button>
      )}

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function toneFor(status: EstimateSnapshot['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'APPROVED') {
    return 'success';
  }

  if (status === 'OUTDATED' || status === 'REVIEW_REQUIRED') {
    return 'warning';
  }

  return 'neutral';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
