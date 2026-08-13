'use client';

import { useState } from 'react';
import { DOCUMENT_LABELS, DOCUMENT_ORDER, type DocumentType } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { useTraceability } from '@/hooks/use-documents';

/**
 * Every approved requirement, and where it ended up.
 *
 * ## The question this screen answers
 *
 * "We agreed to this. Where is it?" With seven documents that is not answerable by
 * reading them — the requirement is cited by key in one, by feature id in another, by
 * estimate unit in a third. This follows the links the documents already recorded.
 *
 * ## The gaps are the point
 *
 * A requirement that is agreed, priced and nowhere in the plan is the expensive kind of
 * mistake, and it is invisible in any single document. So the screen leads with what is
 * missing and lets the reader expand into the detail, rather than presenting a wall of
 * green ticks with one absence buried in it.
 *
 * ## Two documents are optional, and it says so
 *
 * A requirement with no assumption and no client dependency is the ordinary case.
 * Marking those columns as conditional is what stops a reader reading a blank as a
 * failure — and what stops the coverage figure being one nobody could ever reach.
 */
export function TraceabilityPanel({ onOpen }: { readonly onOpen?: (type: DocumentType) => void }) {
  const traceability = useTraceability();
  const [expanded, setExpanded] = useState<string | null>(null);

  const view = traceability.data?.traceability;

  if (traceability.isPending) {
    return (
      <Card role="region" aria-label="Traceability">
        <CardHeader>
          <CardTitle>Traceability</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">Following every requirement through the documents…</p>
        </CardContent>
      </Card>
    );
  }

  if (view?.baselineVersion == null) {
    return (
      <Card role="region" aria-label="Traceability">
        <CardHeader>
          <CardTitle>Traceability</CardTitle>
          <CardDescription>
            There is nothing to trace yet. Approve a requirement baseline first — that is what
            everything else is followed back to.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const blocking = view.gaps.filter((gap) => gap.severity === 'BLOCKING');
  const warnings = view.gaps.filter((gap) => gap.severity === 'WARNING');

  return (
    <Card role="region" aria-label="Traceability">
      <CardHeader>
        <CardTitle>Traceability</CardTitle>
        <CardDescription>
          Every approved requirement, followed through the documents that cite it. Nothing here is
          guessed from the prose — a requirement appears where a document actually recorded it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm" data-testid="trace-summary">
          {view.completeCount} of {view.requirements.length}{' '}
          {view.requirements.length === 1 ? 'requirement' : 'requirements'} appear everywhere they
          are owed
          {blocking.length > 0 ? (
            <>
              {' · '}
              <span className="text-danger" data-testid="trace-blocking">
                {blocking.length} needs attention
              </span>
            </>
          ) : null}
        </p>

        {/* What is missing, first. */}
        {view.gaps.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="trace-gaps">
            {[...blocking, ...warnings].map((gap) => (
              <li
                key={`${gap.kind}-${gap.documentType ?? 'all'}`}
                className={`rounded-md border p-3 text-sm ${
                  gap.severity === 'BLOCKING' ? 'border-danger' : 'border-border'
                }`}
                data-testid={`trace-gap-${gap.kind}`}
              >
                <span className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={gap.severity === 'BLOCKING' ? 'danger' : 'warning'}>
                    {gap.severity === 'BLOCKING' ? 'Needs attention' : 'Worth a look'}
                  </Badge>
                  <span>{gap.summary}</span>
                </span>
                {gap.subjectKeys.length > 0 ? (
                  <p className="mt-1 text-xs text-muted">{gap.subjectKeys.join(', ')}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" data-testid="trace-no-gaps">
            <Badge tone="success">Nothing missing</Badge> Every requirement appears in each document
            that owes it one.
          </p>
        )}

        {/* Coverage per document, including which ones are optional. */}
        <ul className="flex flex-col gap-1" data-testid="trace-coverage">
          {[...view.coverage]
            .sort(
              (first, second) =>
                DOCUMENT_ORDER[first.documentType] - DOCUMENT_ORDER[second.documentType],
            )
            .map((entry) => (
              <li
                key={entry.documentType}
                className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                data-testid={`trace-coverage-${entry.documentType}`}
              >
                <span className="flex flex-wrap items-baseline gap-2">
                  {DOCUMENT_LABELS[entry.documentType]}
                  {entry.conditional ? <Badge tone="neutral">Only where it applies</Badge> : null}
                  {entry.stale ? (
                    <Badge tone="warning" data-testid={`trace-stale-${entry.documentType}`}>
                      Out of date
                    </Badge>
                  ) : null}
                </span>
                <span className="text-muted">
                  {entry.documentVersion === null
                    ? 'not written yet'
                    : `${entry.represented} of ${entry.applicable}${
                        entry.excluded > 0 ? `, ${entry.excluded} deliberately left out` : ''
                      }`}
                </span>
              </li>
            ))}
        </ul>

        {/* And the requirements themselves, expandable. */}
        <ul className="flex flex-col gap-2" data-testid="trace-requirements">
          {view.requirements.map((trace) => (
            <li
              key={trace.requirementKey}
              className="rounded-md border border-border p-3"
              data-testid={`trace-${trace.requirementKey}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-mono text-xs text-muted">{trace.requirementKey}</span>
                  <span>{trace.title}</span>
                  {trace.complete ? null : (
                    <Badge tone="warning" data-testid={`trace-incomplete-${trace.requirementKey}`}>
                      Missing from {trace.missingFrom.length}
                    </Badge>
                  )}
                </span>
                <Button
                  variant="secondary"
                  data-testid={`trace-expand-${trace.requirementKey}`}
                  onClick={() =>
                    setExpanded(expanded === trace.requirementKey ? null : trace.requirementKey)
                  }
                >
                  {expanded === trace.requirementKey ? 'Hide' : 'Where it appears'}
                </Button>
              </div>

              {expanded === trace.requirementKey ? (
                <div className="mt-2 flex flex-col gap-1">
                  {trace.links.length === 0 ? (
                    <p className="text-xs text-muted">
                      This requirement is not cited by any document yet.
                    </p>
                  ) : (
                    trace.links.map((link) => (
                      <span
                        key={`${link.documentType}-${link.key}`}
                        className="flex flex-wrap items-baseline gap-2 text-xs"
                        data-testid={`trace-link-${trace.requirementKey}-${link.documentType}`}
                      >
                        {onOpen ? (
                          <Button
                            variant="secondary"
                            onClick={() => onOpen(link.documentType)}
                            data-testid={`trace-open-${link.documentType}`}
                          >
                            {DOCUMENT_LABELS[link.documentType]}
                          </Button>
                        ) : (
                          <span className="font-medium">{DOCUMENT_LABELS[link.documentType]}</span>
                        )}
                        <span className="font-mono text-muted">{link.key}</span>
                        <span className="text-muted">{link.label}</span>
                        {link.stale ? (
                          <Badge tone="warning">From a version that is out of date</Badge>
                        ) : null}
                      </span>
                    ))
                  )}

                  {trace.missingFrom.length > 0 ? (
                    <p className="text-xs text-danger">
                      Not in {trace.missingFrom.map((type) => DOCUMENT_LABELS[type]).join(', ')}
                    </p>
                  ) : null}
                  {trace.excludedIn.length > 0 ? (
                    <p className="text-xs text-muted">
                      Recorded as deliberately out of scope in{' '}
                      {trace.excludedIn.map((type) => DOCUMENT_LABELS[type]).join(', ')}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
