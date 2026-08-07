'use client';

import {
  RISK_LEVEL_LABELS,
  isBlocking,
  needsAcknowledgement,
  type CompatibilityFinding,
  type StackSnapshot,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useAcknowledgeRisk } from '@/hooks/use-stack';

/**
 * What the application thinks is wrong, and what the user may do about it.
 *
 * The split down the middle of this panel is the whole argument of the phase.
 *
 * **Cannot be approved** is a contradiction with an approved requirement, or a
 * combination that cannot be built. There is no button that makes it go away,
 * because there is nothing here to acknowledge — the stack as written does not
 * work.
 *
 * **Needs your acknowledgement** is everything else serious. The user reads it
 * and keeps their choice. The technology stays, the risk is carried into the
 * estimate and the documents, and the record shows they were told. That is the
 * point at which user authority and honest reporting have to coexist, and
 * acknowledging is how they do.
 *
 * A finding the *model* raised is shown separately and labelled as its opinion,
 * because a rule and an opinion carry different weight and a screen that blurs
 * them teaches people to discount both.
 */
export function CompatibilityPanel({ stack }: { readonly stack: StackSnapshot }) {
  const findings = stack.compatibilityFindings;
  const blocking = findings.filter((finding) => isBlocking(finding.level));
  const acknowledgeable = findings.filter((finding) => needsAcknowledgement(finding.level));
  const informational = findings.filter(
    (finding) => !isBlocking(finding.level) && !needsAcknowledgement(finding.level),
  );

  if (findings.length === 0) {
    return null;
  }

  const acknowledged = new Set(
    stack.components.flatMap((component) =>
      component.riskAcknowledgements.map((entry) => entry.findingId),
    ),
  );

  return (
    // A landmark, so the warnings are reachable directly rather than only by
    // scrolling past the stack — which is how a screen-reader user finds out
    // that something cannot be approved.
    <Card role="region" aria-label="What to look at">
      <CardHeader>
        <CardTitle>What to look at</CardTitle>
        <CardDescription>
          Checked against this application’s reviewed technology facts and your approved
          requirements — not guessed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blocking.length > 0 ? (
          <section aria-label="Cannot be approved" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Cannot be approved ({blocking.length})</h3>
            <ul className="flex flex-col gap-2">
              {blocking.map((finding) => (
                <li key={finding.id}>
                  <FindingCard finding={finding} stack={stack} acknowledged={false} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {acknowledgeable.length > 0 ? (
          <section aria-label="Needs your acknowledgement" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              Needs your acknowledgement ({acknowledgeable.length})
            </h3>
            <p className="text-xs text-muted">
              You can keep your choice. Say you have read the warning and it stops blocking — it
              stays on the record and goes into the documents.
            </p>
            <ul className="flex flex-col gap-2">
              {acknowledgeable.map((finding) => (
                <li key={finding.id}>
                  <FindingCard
                    finding={finding}
                    stack={stack}
                    acknowledged={acknowledged.has(finding.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {informational.length > 0 ? (
          <section aria-label="Worth knowing" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Worth knowing ({informational.length})</h3>
            <ul className="flex flex-col gap-2">
              {informational.map((finding) => (
                <li key={finding.id}>
                  <FindingCard finding={finding} stack={stack} acknowledged={false} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FindingCard({
  finding,
  stack,
  acknowledged,
}: {
  readonly finding: CompatibilityFinding;
  readonly stack: StackSnapshot;
  readonly acknowledged: boolean;
}) {
  const acknowledge = useAcknowledgeRisk();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  return (
    <div className="rounded-md border border-border p-3" data-testid={`finding-${finding.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium">{finding.summary}</p>
        <div className="flex items-center gap-2">
          <Badge tone={isBlocking(finding.level) ? 'danger' : 'warning'}>
            {RISK_LEVEL_LABELS[finding.level]}
          </Badge>
          {/*
            A rule and an opinion are labelled apart. The model can add an
            observation; it cannot make one blocking, and it cannot pass one off
            as a checked fact.
          */}
          {!finding.deterministic ? <Badge tone="neutral">The AI’s opinion</Badge> : null}
        </div>
      </div>

      {finding.impact ? <p className="mt-1 text-xs">{finding.impact}</p> : null}
      {finding.suggestion ? <p className="mt-1 text-xs text-muted">{finding.suggestion}</p> : null}

      {finding.requirementIds.length > 0 ? (
        <p className="mt-1 text-xs text-muted">Because of {finding.requirementIds.join(', ')}</p>
      ) : null}

      {acknowledged ? (
        <p className="mt-2 text-xs text-muted">
          You read this and kept your choice. It stays on the record.
        </p>
      ) : needsAcknowledgement(finding.level) && stack.status !== 'LOCKED' ? (
        <div className="mt-2">
          {open ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                acknowledge.mutate({
                  findingId: finding.id,
                  ...(note.trim() ? { note: note.trim() } : {}),
                  acknowledged: true,
                  expectedVersion: stack.recordVersion,
                });
              }}
            >
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Anything to record about this?</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="rounded-md border border-border px-2 py-1 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={acknowledge.isPending}>
                  I have read this and I am keeping my choice
                </Button>
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setOpen(true)}>
              Acknowledge and keep my choice
            </Button>
          )}

          {acknowledge.isError ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              {acknowledge.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
