'use client';

import { useState } from 'react';
import {
  BLOCKING_SCOPE_LABELS,
  CLIENT_DEPENDENCY_CATEGORY_LABELS,
  DEPENDENCY_PRIORITY_LABELS,
  DEPENDENCY_SOURCE_LABELS,
  DEPENDENCY_STATUS_LABELS,
  canTransitionDependency,
  isDependencySatisfied,
  type ClientDependency,
  type DocumentRow,
  type DocumentSnapshot,
  type DocumentType,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import {
  useReceiveDependency,
  useRequestDependency,
  useUpdateRow,
  useValidateDependency,
} from '@/hooks/use-documents';

/**
 * What we need from the client, and where each item stands.
 *
 * ## Received and accepted are different buttons
 *
 * The single most important thing this screen does. "It arrived" and "we checked it and
 * it works" are separate actions with separate records, because credentials turn up
 * that do not work and exports arrive in the wrong encoding — and a project that
 * collapses the two believes it is unblocked for a fortnight.
 *
 * So a received item shows *Check it* rather than a tick, and accepting requires a note
 * saying what the check showed. That note is the only thing that makes "we were
 * unblocked on the 14th" defensible three months later.
 *
 * ## The blocking ones first
 *
 * A sheet of forty rows where three block a milestone is a different situation from one
 * where thirty do, and nobody should have to read all forty to find out. The summary
 * says what is outstanding and what of it is holding work up.
 *
 * ## Credentials are described, never held
 *
 * A credentials row shows that credentials are needed and where each stands. There is
 * no field for the value, here or in the API — a document version cannot be recalled
 * once it is issued, and this sheet is made to be exported and emailed.
 */
export function DependencySheet({
  type,
  document,
  editable,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
  readonly editable: boolean;
}) {
  const requestDependency = useRequestDependency(type);
  const receiveDependency = useReceiveDependency(type);
  const validateDependency = useValidateDependency(type);
  const updateRow = useUpdateRow(type);

  /** The row being checked, and the note about what the check showed. */
  const [checking, setChecking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [ownerDraft, setOwnerDraft] = useState({ clientOwner: '', internalOwner: '' });

  const summary = document.dependencySummary;
  const rows = document.rows;

  const dependencyOf = (row: DocumentRow): ClientDependency => row.payload as ClientDependency;

  const tone = (dependency: ClientDependency): 'success' | 'warning' | 'danger' | 'neutral' => {
    if (dependency.status === 'ACCEPTED' || dependency.status === 'WAIVED') {
      return 'success';
    }

    if (dependency.status === 'REJECTED') {
      return 'danger';
    }

    /* Received but unchecked is deliberately a warning, not a success. */
    if (dependency.status === 'RECEIVED' || dependency.status === 'PARTIALLY_RECEIVED') {
      return 'warning';
    }

    return 'neutral';
  };

  return (
    <Card role="region" aria-label="Client dependency sheet">
      <CardHeader>
        <CardTitle>What we need from you</CardTitle>
        <CardDescription>
          Everything this project cannot proceed without that somebody outside the delivery team
          provides. Each item records when it was asked for, when it arrived, and what checking it
          showed — arriving and working are tracked separately on purpose.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {summary ? (
          <p className="text-sm" data-testid="dependency-summary">
            {summary.total} {summary.total === 1 ? 'item' : 'items'} · {summary.outstanding}{' '}
            outstanding · {summary.received} received but not checked · {summary.accepted} received
            and working
            {summary.blockingOutstanding.length > 0 ? (
              <>
                {' · '}
                <span className="text-danger" data-testid="dependency-blocking">
                  {summary.blockingOutstanding.length} blocking work
                </span>
              </>
            ) : null}
          </p>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted" data-testid="dependency-empty">
            This sheet has not been written yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="dependency-rows">
            {rows.map((row) => {
              const dependency = dependencyOf(row);
              const satisfied = isDependencySatisfied(dependency.status);

              return (
                <li
                  key={row.rowId}
                  className="rounded-md border border-border p-3"
                  data-testid={`dependency-row-${dependency.dependencyKey}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-muted">
                        {dependency.dependencyKey}
                      </span>
                      <span className="text-sm font-medium">{dependency.dependency}</span>
                      <Badge tone="neutral">
                        {CLIENT_DEPENDENCY_CATEGORY_LABELS[dependency.category]}
                      </Badge>
                      <Badge
                        tone={tone(dependency)}
                        data-testid={`dependency-status-${dependency.dependencyKey}`}
                      >
                        {DEPENDENCY_STATUS_LABELS[dependency.status]}
                      </Badge>
                      {dependency.credentialsRequired ? (
                        <Badge
                          tone="neutral"
                          data-testid={`dependency-credentials-${dependency.dependencyKey}`}
                        >
                          Credentials
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted">
                      {DEPENDENCY_PRIORITY_LABELS[dependency.priority]} ·{' '}
                      {dependency.actualDueDate ?? dependency.relativeDue}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-col gap-1 text-xs text-muted">
                    {dependency.description ? <span>{dependency.description}</span> : null}
                    {dependency.purpose ? <span>Why: {dependency.purpose}</span> : null}
                    {dependency.expectedFormat ? (
                      <span>What we need: {dependency.expectedFormat}</span>
                    ) : null}
                    {dependency.blocking !== 'NONE' && !satisfied ? (
                      <span
                        className="text-danger"
                        data-testid={`dependency-impact-${dependency.dependencyKey}`}
                      >
                        {BLOCKING_SCOPE_LABELS[dependency.blocking]}. {dependency.impactIfDelayed}
                      </span>
                    ) : null}
                    <span data-testid={`dependency-source-${dependency.dependencyKey}`}>
                      From{' '}
                      {dependency.sourceKinds
                        .map((kind) => DEPENDENCY_SOURCE_LABELS[kind])
                        .join(', ')}
                      {dependency.wbsIds.length > 0
                        ? ` · needed for ${dependency.wbsIds.join(', ')}`
                        : ''}
                    </span>
                    {dependency.clientOwner || dependency.internalOwner ? (
                      <span data-testid={`dependency-owner-${dependency.dependencyKey}`}>
                        {dependency.clientOwner ? `Your side: ${dependency.clientOwner}` : ''}
                        {dependency.clientOwner && dependency.internalOwner ? ' · ' : ''}
                        {dependency.internalOwner ? `Our side: ${dependency.internalOwner}` : ''}
                      </span>
                    ) : null}
                    {dependency.validationNote ? (
                      <span data-testid={`dependency-note-${dependency.dependencyKey}`}>
                        Checked: {dependency.validationNote}
                      </span>
                    ) : null}
                  </div>

                  {/* Checking an item: the note is required, in both directions. */}
                  {checking === row.rowId ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <label className="flex flex-col gap-1 text-xs">
                        What did you check, and what did it show?
                        <textarea
                          rows={2}
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          data-testid={`dependency-check-note-${dependency.dependencyKey}`}
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={note.trim().length === 0 || validateDependency.isPending}
                          data-testid={`dependency-accept-${dependency.dependencyKey}`}
                          onClick={() => {
                            void validateDependency
                              .mutateAsync({
                                rowId: row.rowId,
                                outcome: 'ACCEPTED',
                                note,
                                expectedVersion: document.recordVersion,
                              })
                              .then(() => {
                                setChecking(null);
                                setNote('');
                              });
                          }}
                        >
                          It works
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={note.trim().length === 0 || validateDependency.isPending}
                          data-testid={`dependency-reject-${dependency.dependencyKey}`}
                          onClick={() => {
                            void validateDependency
                              .mutateAsync({
                                rowId: row.rowId,
                                outcome: 'REJECTED',
                                note,
                                expectedVersion: document.recordVersion,
                              })
                              .then(() => {
                                setChecking(null);
                                setNote('');
                              });
                          }}
                        >
                          It is not usable
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setChecking(null);
                            setNote('');
                          }}
                          data-testid={`dependency-check-cancel-${dependency.dependencyKey}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {owner === row.rowId ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-xs">
                          Who owns this on your side
                          <input
                            className="rounded-md border border-border bg-surface p-2 text-sm"
                            value={ownerDraft.clientOwner}
                            onChange={(event) =>
                              setOwnerDraft({ ...ownerDraft, clientOwner: event.target.value })
                            }
                            data-testid={`dependency-client-owner-${dependency.dependencyKey}`}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                          Who is chasing it here
                          <input
                            className="rounded-md border border-border bg-surface p-2 text-sm"
                            value={ownerDraft.internalOwner}
                            onChange={(event) =>
                              setOwnerDraft({ ...ownerDraft, internalOwner: event.target.value })
                            }
                            data-testid={`dependency-internal-owner-${dependency.dependencyKey}`}
                          />
                        </label>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={updateRow.isPending}
                          data-testid={`dependency-owner-save-${dependency.dependencyKey}`}
                          onClick={() => {
                            void updateRow
                              .mutateAsync({
                                rowId: row.rowId,
                                payload: { ...dependency, ...ownerDraft },
                                expectedVersion: document.recordVersion,
                              })
                              .then(() => setOwner(null));
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => setOwner(null)}
                          data-testid={`dependency-owner-cancel-${dependency.dependencyKey}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {editable && checking !== row.rowId && owner !== row.rowId ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {canTransitionDependency(dependency.status, 'REQUESTED') ? (
                        <Button
                          variant="secondary"
                          disabled={requestDependency.isPending}
                          data-testid={`dependency-request-${dependency.dependencyKey}`}
                          onClick={() => {
                            void requestDependency.mutateAsync({
                              rowId: row.rowId,
                              expectedVersion: document.recordVersion,
                            });
                          }}
                        >
                          Mark as asked for
                        </Button>
                      ) : null}

                      {canTransitionDependency(dependency.status, 'RECEIVED') ? (
                        <Button
                          variant="secondary"
                          disabled={receiveDependency.isPending}
                          data-testid={`dependency-receive-${dependency.dependencyKey}`}
                          onClick={() => {
                            void receiveDependency.mutateAsync({
                              rowId: row.rowId,
                              partial: false,
                              expectedVersion: document.recordVersion,
                            });
                          }}
                        >
                          It arrived
                        </Button>
                      ) : null}

                      {canTransitionDependency(dependency.status, 'PARTIALLY_RECEIVED') ? (
                        <Button
                          variant="secondary"
                          disabled={receiveDependency.isPending}
                          data-testid={`dependency-receive-partial-${dependency.dependencyKey}`}
                          onClick={() => {
                            void receiveDependency.mutateAsync({
                              rowId: row.rowId,
                              partial: true,
                              expectedVersion: document.recordVersion,
                            });
                          }}
                        >
                          Some of it arrived
                        </Button>
                      ) : null}

                      {/*
                       * Only ever offered as a check, never as "accept". Something that
                       * turned up is not something that works, and this button is where
                       * that distinction is either kept or quietly lost.
                       */}
                      {canTransitionDependency(dependency.status, 'ACCEPTED') ? (
                        <Button
                          data-testid={`dependency-check-${dependency.dependencyKey}`}
                          onClick={() => {
                            setChecking(row.rowId);
                            setNote('');
                          }}
                        >
                          Check it
                        </Button>
                      ) : null}

                      <Button
                        variant="secondary"
                        data-testid={`dependency-set-owner-${dependency.dependencyKey}`}
                        onClick={() => {
                          setOwner(row.rowId);
                          setOwnerDraft({
                            clientOwner: dependency.clientOwner,
                            internalOwner: dependency.internalOwner,
                          });
                        }}
                      >
                        {dependency.clientOwner || dependency.internalOwner
                          ? 'Change who owns it'
                          : 'Say who owns it'}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {requestDependency.isError ||
        receiveDependency.isError ||
        validateDependency.isError ||
        updateRow.isError ? (
          <p role="alert" className="text-sm text-danger" data-testid="dependency-error">
            {
              (
                requestDependency.error ??
                receiveDependency.error ??
                validateDependency.error ??
                updateRow.error
              )?.message
            }
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
