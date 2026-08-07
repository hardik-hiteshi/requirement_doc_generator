'use client';

import {
  BASELINE_STATUS_LABELS,
  OUTDATED_REASON_MESSAGES,
  REQUIREMENT_CATEGORY_LABELS,
  type Baseline,
  type RequirementCategory,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useApproveBaseline,
  useBaseline,
  useRequirements,
  useStartBaselineReview,
} from '@/hooks/use-analysis';

/**
 * The baseline, and the decision to approve it.
 *
 * Two things about this screen are non-negotiable.
 *
 * **The blockers are shown before the button, and the button is disabled while
 * any remain.** A gate that refuses without saying why is one people route
 * around; each blocker names what is wrong and what to do about it, and links to
 * the records concerned.
 *
 * **The completeness figures do not flatter.** Alignment is capped while
 * anything is unresolved and says why in plain language. A number near 100
 * beside six open conflicts is not an optimistic estimate — it is a false
 * statement in a document somebody is about to sign.
 */
export function BaselineStep() {
  const { data, isPending, isError } = useBaseline();
  const { data: requirements } = useRequirements();
  const review = useStartBaselineReview();
  const approve = useApproveBaseline();
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState('');

  if (isPending) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted">Loading the baseline…</p>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted">
            No baseline yet. Run the analysis first — the baseline is what it produces.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { baseline, notice } = data;
  const canApprove =
    baseline.blockers.length === 0 &&
    baseline.itemCount > 0 &&
    (baseline.status === 'draft' || baseline.status === 'in_review');

  return (
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="baseline-title">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle id="baseline-title">Requirement baseline v{baseline.version}</CardTitle>
            <Badge
              tone={
                baseline.status === 'approved'
                  ? 'success'
                  : baseline.status === 'outdated'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {BASELINE_STATUS_LABELS[baseline.status]}
            </Badge>
          </div>
          {/* Never in a footer. The reader has to know what this is while they
              are looking at it, not after they have scrolled past. */}
          <CardDescription>{notice}</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {baseline.status === 'outdated' && baseline.outdatedReason ? (
            <p
              role="alert"
              className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm"
            >
              {OUTDATED_REASON_MESSAGES[baseline.outdatedReason]} What was approved has not changed
              — run the analysis again to produce a new version.
            </p>
          ) : null}

          <Metrics baseline={baseline} />

          {baseline.alignment.incompleteReasons.length > 0 ? (
            <div className="rounded-md border border-border bg-surface-raised p-3 text-sm">
              <p className="font-medium">Why this is not complete</p>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {baseline.alignment.incompleteReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <CategoryBreakdown counts={baseline.categoryCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {baseline.blockers.length === 0
              ? 'Ready to approve'
              : `Before you can approve (${baseline.blockers.length})`}
          </CardTitle>
          <CardDescription>
            {baseline.blockers.length === 0
              ? 'Everything traces to a document, and nothing is outstanding.'
              : 'Each of these has to be dealt with. Nothing here is a formality.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {baseline.blockers.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {baseline.blockers.map((blocker) => (
                <li
                  key={blocker.kind}
                  className="rounded-lg border border-danger/30 bg-danger-soft/40 p-3"
                >
                  <p className="text-sm font-medium">{blocker.summary}</p>
                  <p className="text-xs text-muted">{blocker.action}</p>
                </li>
              ))}
            </ul>
          ) : null}

          {baseline.status === 'draft' ? (
            <Button
              variant="secondary"
              disabled={review.isPending}
              onClick={() => review.mutate()}
              className="w-fit"
            >
              Start reviewing
            </Button>
          ) : null}

          {baseline.status === 'approved' ? (
            <p className="text-sm">
              Approved
              {baseline.approvedAt ? ` on ${new Date(baseline.approvedAt).toLocaleString()}` : ''}.
              {baseline.approvalNote ? ` ${baseline.approvalNote}` : ''}
            </p>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                approve.mutate({
                  ...(note ? { note } : {}),
                  acknowledgedAiAssistance: true,
                  expectedVersion: baseline.recordVersion,
                });
              }}
            >
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Note (optional)</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="rounded-md border border-border px-2 py-1 text-sm"
                />
              </label>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I have read these requirements and I am approving them.
                  <span className="block text-xs text-muted">
                    A model drafted them from your documents. Approving is a person’s decision, and
                    this records that you made it.
                  </span>
                </span>
              </label>

              <Button
                type="submit"
                disabled={!canApprove || !acknowledged || approve.isPending}
                className="w-fit"
              >
                {approve.isPending ? 'Approving…' : 'Approve this baseline'}
              </Button>

              {!canApprove && baseline.blockers.length > 0 ? (
                <p className="text-xs text-muted">
                  Approval is unavailable while anything above is outstanding.
                </p>
              ) : null}

              {approve.isError ? (
                <p role="alert" className="text-sm text-danger">
                  {approve.error.message}
                </p>
              ) : null}
            </form>
          )}
        </CardContent>
      </Card>

      {requirements && requirements.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>What is in it</CardTitle>
            <CardDescription>
              {baseline.itemCount} requirements. Assumptions are labelled, so nothing taken for
              granted reads as something the client said.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {requirements
                .filter((item) => baseline.itemIds.includes(item.id))
                .map((item) => (
                  <li key={item.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-mono text-xs text-muted">{item.key}</span>
                    {item.category === 'assumption' ? (
                      <Badge tone="warning">Assumption</Badge>
                    ) : null}
                    <span>{item.title}</span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Metrics({ baseline }: { readonly baseline: Baseline }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <Metric
        label="Documents accounted for"
        value={`${Math.round(baseline.coverage.ratio * 100)}%`}
        note={
          baseline.coverage.notAnalysedBlocks > 0
            ? `${baseline.coverage.notAnalysedBlocks} parts were never analysed`
            : 'Every part was read'
        }
      />
      <Metric
        label="Alignment with your documents"
        value={`${Math.round(baseline.alignment.overall * 100)}%`}
        note={
          baseline.alignment.isComplete
            ? 'Nothing outstanding'
            : 'Capped while anything is unresolved'
        }
      />
      <Metric
        label="Traceable requirements"
        value={`${Math.round(baseline.alignment.traceability * 100)}%`}
        note="Quoted from a document and checked"
      />
    </dl>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}) {
  /*
   * The note lives inside the <dd>, not beside it.
   *
   * A <dl> that uses <div> wrappers may put only <dt> and <dd> in each one — a
   * sibling <p> is invalid, and axe says so. Caught by the browser suite.
   */
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd>
        <span className="block text-2xl font-semibold">{value}</span>
        <span className="block text-xs text-muted">{note}</span>
      </dd>
    </div>
  );
}

function CategoryBreakdown({ counts }: { readonly counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([category, count]) => (
        <Badge key={category} tone="neutral">
          {REQUIREMENT_CATEGORY_LABELS[category as RequirementCategory] ?? category}: {count}
        </Badge>
      ))}
    </div>
  );
}
