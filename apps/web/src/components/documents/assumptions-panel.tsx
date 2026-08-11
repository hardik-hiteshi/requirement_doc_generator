'use client';

import { useState } from 'react';
import {
  entersApprovedDocument,
  ASSUMPTION_CATEGORY_LABELS,
  ASSUMPTION_STATUS_LABELS,
  IMPACT_LABELS,
  IMPACT_AREA_LABELS,
  PROVENANCE_LABELS,
  type Assumption,
  type DocumentRow,
  type DocumentSnapshot,
  type DocumentType,
} from '@wdrg/contracts';

import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import {
  useAssumptionCandidates,
  useConfirmAssumption,
  useRejectAssumption,
} from '@/hooks/use-documents';

/**
 * The assumptions, with who stands behind each one.
 *
 * The interface has one job beyond listing: making the difference between a
 * suggestion and an assumption impossible to miss. A candidate says "Candidate",
 * says nobody has stood behind it, and cannot be in an approved document. Confirming
 * one asks what it rests on, because that question is the whole of what makes an
 * assumption usable six months later.
 *
 * An empty document is shown as a result, not as an absence to be filled. A project
 * where nobody has flagged an assumption genuinely has none recorded, and the screen
 * says so rather than prompting somebody to invent a few.
 */
export function AssumptionsPanel({
  type,
  document,
  editable,
  aiAvailable,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
  readonly editable: boolean;
  readonly aiAvailable: boolean;
}) {
  const confirm = useConfirmAssumption(type);
  const reject = useRejectAssumption(type);
  const suggest = useAssumptionCandidates(type);

  const [deciding, setDeciding] = useState<string | null>(null);
  const [basis, setBasis] = useState('');
  const [provenance, setProvenance] = useState<
    'CLIENT_STATED' | 'USER_STATED' | 'CONFIRMED_CLARIFICATION'
  >('CLIENT_STATED');
  const [owner, setOwner] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const assumptionOf = (row: DocumentRow): Assumption => row.payload as Assumption;
  const summary = document.assumptionSummary;

  return (
    <Card role="region" aria-label="Assumptions">
      <CardHeader>
        <CardTitle>Assumptions</CardTitle>
        <CardDescription>
          What this plan is resting on. Something only becomes an assumption when you say it is one
          — a gap in the requirements is a question to ask, not an assumption to make.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {summary ? (
          <p className="text-sm" data-testid="assumption-summary">
            {summary.total === 0
              ? 'Nothing has been recorded as an assumption for this project.'
              : `${summary.confirmed} confirmed, ${summary.candidates} waiting for a decision, ${summary.rejected} turned down.`}
          </p>
        ) : null}

        {summary?.total === 0 ? (
          <p className="text-xs text-muted" data-testid="assumptions-empty">
            That is a complete answer, not a gap. Nothing is added here on your behalf: an
            assumption needs somebody behind it, and a document full of invented assumptions would
            read as agreed when nobody had agreed to anything.
          </p>
        ) : null}

        {editable && aiAvailable ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <p className="text-sm">
              Ask for suggestions about what this plan appears to be resting on.
            </p>
            <p className="text-xs text-muted">
              Everything that comes back is a suggestion for you to accept or turn down. None of it
              becomes an assumption on its own, and none of it reaches an approved document until
              you say so.
            </p>
            <Button
              variant="secondary"
              className="self-start"
              disabled={suggest.isPending}
              data-testid="assumptions-suggest"
              onClick={() =>
                suggest.mutate({ useAi: true, expectedVersion: document.recordVersion })
              }
            >
              Suggest some candidates
            </Button>
            {suggest.isError ? (
              <p
                role="alert"
                className="text-xs text-danger"
                data-testid="assumptions-suggest-error"
              >
                {suggest.error.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <ul className="flex flex-col gap-3">
          {document.rows.map((row) => {
            const assumption = assumptionOf(row);
            const isCandidate = assumption.status === 'DRAFT';
            const counts = entersApprovedDocument(assumption);

            return (
              <li
                key={row.rowId}
                className="rounded-md border border-border p-3"
                data-testid={`assumption-${assumption.assumptionKey}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{assumption.assumptionKey}</Badge>
                  <Badge tone="neutral">{ASSUMPTION_CATEGORY_LABELS[assumption.category]}</Badge>
                  <Badge
                    tone={isCandidate ? 'warning' : counts ? 'success' : 'neutral'}
                    data-testid={`assumption-status-${assumption.assumptionKey}`}
                  >
                    {ASSUMPTION_STATUS_LABELS[assumption.status]}
                  </Badge>
                  <Badge tone={assumption.impact === 'BLOCKING' ? 'danger' : 'neutral'}>
                    {IMPACT_LABELS[assumption.impact]} if wrong
                  </Badge>
                </div>

                <p
                  className="mt-2 text-sm"
                  data-testid={`assumption-text-${assumption.assumptionKey}`}
                >
                  {assumption.statement}
                </p>

                <p
                  className="mt-1 text-xs text-muted"
                  data-testid={`assumption-provenance-${assumption.assumptionKey}`}
                >
                  {PROVENANCE_LABELS[assumption.provenance]}
                  {assumption.basis ? ` — ${assumption.basis}` : ''}
                </p>

                {assumption.impactIfFalse ? (
                  <p className="mt-1 text-xs">If it is wrong: {assumption.impactIfFalse}</p>
                ) : null}

                {assumption.impactAreas.length > 0 ? (
                  <p className="mt-1 text-xs text-muted">
                    Affects{' '}
                    {assumption.impactAreas.map((area) => IMPACT_AREA_LABELS[area]).join(', ')}
                  </p>
                ) : null}

                {assumption.owner ? (
                  <p className="mt-1 text-xs text-muted">Owner: {assumption.owner}</p>
                ) : null}

                {assumption.validationNeeded ? (
                  <p className="mt-1 text-xs text-muted">
                    To settle it: {assumption.validationNeeded}
                  </p>
                ) : null}

                {assumption.rejectedReason ? (
                  <p className="mt-1 text-xs text-muted">
                    Turned down: {assumption.rejectedReason}
                  </p>
                ) : null}

                {editable && isCandidate ? (
                  deciding === row.rowId ? (
                    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
                      <label className="flex flex-col gap-1 text-xs">
                        What does it rest on?
                        <select
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={provenance}
                          onChange={(event) =>
                            setProvenance(event.target.value as typeof provenance)
                          }
                          data-testid={`assumption-provenance-select-${assumption.assumptionKey}`}
                        >
                          <option value="CLIENT_STATED">The client stated this</option>
                          <option value="USER_STATED">I am stating this</option>
                          <option value="CONFIRMED_CLARIFICATION">
                            A clarification settled it
                          </option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        Where, when, or who said it
                        <input
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={basis}
                          onChange={(event) => setBasis(event.target.value)}
                          data-testid={`assumption-basis-${assumption.assumptionKey}`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        Who is responsible for it being true (optional)
                        <input
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={owner}
                          onChange={(event) => setOwner(event.target.value)}
                          data-testid={`assumption-owner-${assumption.assumptionKey}`}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={confirm.isPending || basis.trim() === ''}
                          data-testid={`assumption-confirm-save-${assumption.assumptionKey}`}
                          onClick={() => {
                            void confirm
                              .mutateAsync({
                                rowId: row.rowId,
                                provenance,
                                basis: basis.trim(),
                                ...(owner.trim() ? { owner: owner.trim() } : {}),
                                expectedVersion: document.recordVersion,
                              })
                              .then(() => {
                                setDeciding(null);
                                setBasis('');
                                setOwner('');
                              });
                          }}
                        >
                          Confirm it
                        </Button>
                        <Button variant="secondary" onClick={() => setDeciding(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        data-testid={`assumption-confirm-${assumption.assumptionKey}`}
                        onClick={() => setDeciding(row.rowId)}
                      >
                        Stand behind it
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={reject.isPending}
                        data-testid={`assumption-reject-${assumption.assumptionKey}`}
                        onClick={() =>
                          reject.mutate({
                            rowId: row.rowId,
                            reason: rejectReason.trim() || 'Not an assumption we are making.',
                            expectedVersion: document.recordVersion,
                          })
                        }
                      >
                        Turn it down
                      </Button>
                      <input
                        className="rounded-md border border-border bg-surface p-2 text-xs"
                        placeholder="Why not (optional)"
                        value={rejectReason}
                        onChange={(event) => setRejectReason(event.target.value)}
                        aria-label={`Why ${assumption.assumptionKey} is being turned down`}
                        data-testid={`assumption-reject-reason-${assumption.assumptionKey}`}
                      />
                    </div>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
