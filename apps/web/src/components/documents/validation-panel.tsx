'use client';

import type { DocumentSnapshot, DocumentType } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { useAcknowledgeFinding, useValidateDocument } from '@/hooks/use-documents';

/**
 * What the checks found, and who found it.
 *
 * Every finding says whether it came from arithmetic or from a model reading the
 * document back, because those are different kinds of claim and a reviewer should
 * weigh them differently. A blocking finding is arithmetic by construction — the
 * model's contribution can only ever be a warning.
 *
 * `PASS` entries are shown rather than hidden. "Coverage is complete" and
 * "the hours match the estimate" are the two things somebody most wants confirmed
 * before they approve, and an empty panel confirms nothing.
 */
export function ValidationPanel({
  type,
  document,
  aiAvailable,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
  readonly aiAvailable: boolean;
}) {
  const validate = useValidateDocument(type);
  const acknowledge = useAcknowledgeFinding(type);

  const validation = document.validation;
  const current = validation?.documentVersion === document.version;

  return (
    <Card role="region" aria-label="Document validation">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Checks</CardTitle>
          <Badge
            tone={
              !validation || !current
                ? 'neutral'
                : validation.severity === 'BLOCKING'
                  ? 'danger'
                  : validation.severity === 'WARNING'
                    ? 'warning'
                    : 'success'
            }
            data-testid="validation-severity"
          >
            {!validation ? 'Not checked' : !current ? 'Out of step' : validation.severity}
          </Badge>
        </div>
        <CardDescription>
          The checks are arithmetic over your approved requirements, stack and estimate. A model may
          add a warning; it can never clear one.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button
          className="self-start"
          onClick={() => validate.mutate(aiAvailable)}
          disabled={validate.isPending}
          data-testid="validate-document"
        >
          {validate.isPending ? 'Checking…' : 'Check this document'}
        </Button>

        {validate.isError ? (
          <p role="alert" className="text-sm text-danger">
            {validate.error.message}
          </p>
        ) : null}

        {validation && !current ? (
          <p className="text-sm text-muted" data-testid="validation-stale">
            This result describes an earlier version. Check it again before approving.
          </p>
        ) : null}

        {validation ? (
          <ul className="flex flex-col gap-2">
            {validation.findings.map((finding, index) => (
              <li
                key={`${finding.kind}-${index}`}
                className="rounded-md border border-border p-3 text-sm"
                data-testid={`finding-${finding.kind}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{finding.summary}</span>
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        finding.severity === 'BLOCKING'
                          ? 'danger'
                          : finding.severity === 'WARNING'
                            ? 'warning'
                            : 'success'
                      }
                    >
                      {finding.severity}
                    </Badge>
                    <Badge tone="neutral">
                      {finding.detectedBy === 'MODEL' ? 'Read back by the model' : 'Checked'}
                    </Badge>
                  </div>
                </div>
                {finding.action ? (
                  <p className="mt-1 text-xs text-muted">{finding.action}</p>
                ) : null}
                {finding.severity === 'WARNING' && !finding.acknowledgedAt ? (
                  <Button
                    variant="secondary"
                    className="mt-2"
                    data-testid={`acknowledge-${finding.kind}`}
                    disabled={acknowledge.isPending}
                    onClick={() =>
                      acknowledge.mutate({
                        kind: finding.kind,
                        acknowledged: true,
                        expectedVersion: document.recordVersion,
                      })
                    }
                  >
                    I have read this
                  </Button>
                ) : null}
                {finding.acknowledgedAt ? (
                  <p className="mt-1 text-xs text-muted">You read this and accepted it.</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Nothing has been checked yet. A document cannot be approved without it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
