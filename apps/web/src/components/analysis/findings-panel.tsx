'use client';

import {
  BLOCKING_CONFLICT_STATUSES,
  CONFLICT_STATUS_LABELS,
  MISSING_DIMENSION_LABELS,
  type AmbiguityFinding,
  type Conflict,
  type DuplicateGroup,
  type MissingInfoFinding,
  type RequirementItem,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useConflictHistory,
  useResolveConflict,
  useResolveDuplicate,
  useResolveFinding,
} from '@/hooks/use-analysis';
import type { FindingsResponse } from '@/lib/analysis-api';

/**
 * What the analysis found and will not act on.
 *
 * Every control here asks the user to decide. Nothing has a default action,
 * nothing is pre-selected, and there is no "resolve all" — because each of these
 * decisions destroys information if it is made wrongly, and a bulk control is an
 * invitation to make it wrongly at scale.
 *
 * Conflicts come first, and they are the reason the phase chunks and then
 * reconciles: a requirement stated in one document and contradicted in another
 * is invisible to either document alone.
 */
export function FindingsPanel({
  findings,
  items,
}: {
  readonly findings: FindingsResponse;
  readonly items: readonly RequirementItem[];
}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const open = (status: string) => status === 'open';

  // A re-evaluated conflict that is still a contradiction is still outstanding,
  // however it got there.
  const openConflicts = findings.conflicts.filter((finding) =>
    BLOCKING_CONFLICT_STATUSES.includes(finding.status),
  );
  const settledConflicts = findings.conflicts.filter(
    (finding) => finding.status === 'resolved_by_clarification',
  );
  const openDuplicates = findings.duplicates.filter((finding) => open(finding.status));
  const openAmbiguities = findings.ambiguities.filter((finding) => open(finding.status));
  const openGaps = findings.gaps.filter((finding) => open(finding.status));

  const total =
    openConflicts.length + openDuplicates.length + openAmbiguities.length + openGaps.length;

  return (
    <Card role="region" aria-labelledby="findings-title">
      <CardHeader>
        <CardTitle id="findings-title">What needs your decision</CardTitle>
        <CardDescription>
          {total === 0
            ? 'Nothing is outstanding. Every finding has been decided.'
            : 'None of these are decided for you. Merging a duplicate or picking a winner between two contradictory requirements is a decision about the project, not about the text.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {openConflicts.length > 0 ? (
          <Section
            title={`Contradictions (${openConflicts.length})`}
            note="Two requirements that cannot both be satisfied. The blocking ones stop the baseline being approved."
          >
            {openConflicts.map((conflict) => (
              <ConflictRow key={conflict.id} conflict={conflict} byId={byId} />
            ))}
          </Section>
        ) : null}

        {settledConflicts.length > 0 ? (
          <Section
            title={`Settled by a client answer (${settledConflicts.length})`}
            note="A confirmed clarification updated every side of these, so they are no longer contradictions. The original wording is kept."
          >
            {settledConflicts.map((conflict) => (
              <SettledConflictRow key={conflict.id} conflict={conflict} />
            ))}
          </Section>
        ) : null}

        {openDuplicates.length > 0 ? (
          <Section
            title={`Possible duplicates (${openDuplicates.length})`}
            note="The same requirement, more than once. Keeping them separate is a valid answer."
          >
            {openDuplicates.map((group) => (
              <DuplicateRow key={group.id} group={group} byId={byId} />
            ))}
          </Section>
        ) : null}

        {openAmbiguities.length > 0 ? (
          <Section
            title={`Unclear wording (${openAmbiguities.length})`}
            note="Language too vague to build from. Any suggested rewording is a suggestion — nothing is changed for you."
          >
            {openAmbiguities.map((finding) => (
              <AmbiguityRow key={finding.id} finding={finding} byId={byId} />
            ))}
          </Section>
        ) : null}

        {openGaps.length > 0 ? (
          <Section
            title={`Missing detail (${openGaps.length})`}
            note="Dimensions a requirement needs but does not state. Nothing has been invented to fill them."
          >
            {openGaps.map((finding) => (
              <GapRow key={finding.id} finding={finding} byId={byId} />
            ))}
          </Section>
        ) : null}

        {total === 0 ? <p className="text-sm text-muted">Nothing outstanding.</p> : null}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-muted">{note}</p>
      </div>
      <ul className="flex flex-col gap-3">{children}</ul>
    </section>
  );
}

function ConflictRow({
  conflict,
  byId,
}: {
  readonly conflict: Conflict;
  readonly byId: ReadonlyMap<string, RequirementItem>;
}) {
  const resolve = useResolveConflict();
  const [note, setNote] = useState('');

  return (
    <li className="rounded-lg border border-danger/30 bg-danger-soft/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={conflict.severity === 'blocking' ? 'danger' : 'warning'}>
          {conflict.severity === 'blocking' ? 'Blocks approval' : conflict.severity}
        </Badge>
        <Badge tone={conflict.status === 'needs_review' ? 'warning' : 'neutral'}>
          {CONFLICT_STATUS_LABELS[conflict.status]}
        </Badge>
        <Badge tone="neutral">{conflict.kind.replace(/_/g, ' ')}</Badge>
        {conflict.crossSource ? (
          /* The case the whole reconciliation stage exists for. */
          <Badge tone="info">Across two documents</Badge>
        ) : null}
      </div>

      <p className="mt-2 text-sm">{conflict.summary}</p>

      {/* What a clarification already tried, and why it did not settle it. */}
      {conflict.reevaluations.length > 0 ? (
        <p className="mt-2 rounded-md border border-border bg-surface-raised p-2 text-xs">
          <span className="font-medium">
            Re-checked after {conflict.reevaluations.at(-1)?.clarificationKey}:{' '}
          </span>
          {conflict.reevaluations.at(-1)?.rationale}
        </p>
      ) : null}

      <ul className="mt-3 flex flex-col gap-2">
        {conflict.positions.map((position) => (
          <li key={position.itemId} className="rounded-md border border-border bg-surface p-3">
            <p className="text-xs text-muted">
              {byId.get(position.itemId)?.key ?? 'Requirement'}
              {position.sourceName ? ` · ${position.sourceName}` : ''}
            </p>
            <p className="text-sm">{position.statement}</p>
            <Button
              className="mt-2"
              variant="secondary"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({
                  conflictId: conflict.id,
                  action: 'choose',
                  winningItemId: position.itemId,
                  ...(note ? { note } : {}),
                  expectedVersion: conflict.version,
                })
              }
            >
              This one is correct
            </Button>
          </li>
        ))}
      </ul>

      <label className="mt-3 flex flex-col gap-1 text-xs">
        <span className="font-medium">Why (optional, but worth writing)</span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-md border border-border px-2 py-1 text-sm"
          placeholder="A decision without a reason is hard to defend in three months."
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              conflictId: conflict.id,
              action: 'keep_both',
              ...(note ? { note } : {}),
              expectedVersion: conflict.version,
            })
          }
        >
          They do not actually conflict
        </Button>
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              conflictId: conflict.id,
              action: 'ask_client',
              ...(note ? { note } : {}),
              expectedVersion: conflict.version,
            })
          }
        >
          Ask the client
        </Button>
      </div>

      {resolve.isError ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {resolve.error.message}
        </p>
      ) : null}
    </li>
  );
}

/** A conflict a confirmed answer settled, with the trail that shows why. */
function SettledConflictRow({ conflict }: { readonly conflict: Conflict }) {
  const [showHistory, setShowHistory] = useState(false);
  const { data: history } = useConflictHistory(showHistory ? conflict.id : undefined);
  const settled = conflict.reevaluations.at(-1);

  return (
    <li className="rounded-lg border border-success/30 bg-success-soft/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">{CONFLICT_STATUS_LABELS[conflict.status]}</Badge>
        {settled ? <Badge tone="neutral">From {settled.clarificationKey}</Badge> : null}
      </div>

      <p className="mt-2 text-sm">{conflict.summary}</p>
      {settled ? <p className="mt-1 text-xs text-muted">{settled.rationale}</p> : null}

      <Button
        className="mt-3"
        variant="secondary"
        onClick={() => setShowHistory((current) => !current)}
        aria-expanded={showHistory}
      >
        {showHistory ? 'Hide what it used to say' : 'What was conflicting before?'}
      </Button>

      {showHistory && history ? (
        <ol className="mt-3 flex flex-col gap-2">
          {history.map((version) => (
            <li
              key={`${version.version}-${version.recordedAt}`}
              className="rounded-md border border-border bg-surface p-3 text-xs"
            >
              <p className="text-muted">
                {version.changedBy === 'analysis'
                  ? 'As found'
                  : version.changedBy === 'user_decision'
                    ? 'Before your decision'
                    : `Before ${version.clarificationKey ?? 'a clarification'}`}
              </p>
              {version.positions.map((position, index) => (
                <p key={`${position.itemId}-${index}`} className="mt-1">
                  <span className="text-muted">
                    {position.sourceName ? `${position.sourceName}: ` : ''}
                  </span>
                  {position.statement}
                </p>
              ))}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function DuplicateRow({
  group,
  byId,
}: {
  readonly group: DuplicateGroup;
  readonly byId: ReadonlyMap<string, RequirementItem>;
}) {
  const resolve = useResolveDuplicate();
  const [primaryId, setPrimaryId] = useState(group.suggestedPrimaryId);

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{group.kind}</Badge>
        {group.crossSource ? <Badge tone="info">Across two documents</Badge> : null}
        {group.similarity > 0 ? (
          <span className="text-xs text-muted">{Math.round(group.similarity * 100)}% alike</span>
        ) : null}
      </div>

      <p className="mt-2 text-sm">{group.rationale}</p>

      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="text-xs font-medium">Which wording would you keep?</legend>
        {group.itemIds.map((itemId) => {
          const item = byId.get(itemId);

          return (
            <label key={itemId} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`primary-${group.id}`}
                value={itemId}
                checked={primaryId === itemId}
                onChange={() => setPrimaryId(itemId)}
                className="mt-1"
              />
              <span>
                <span className="font-mono text-xs text-muted">{item?.key ?? itemId}</span>{' '}
                {item?.statement ?? ''}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              groupId: group.id,
              action: 'merge',
              primaryId,
              expectedVersion: group.version,
            })
          }
        >
          Merge, keeping that one
        </Button>
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              groupId: group.id,
              action: 'keep_separate',
              expectedVersion: group.version,
            })
          }
        >
          Keep them separate
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted">
        Merging does not delete anything. The others are kept, marked as replaced by the one you
        keep.
      </p>

      {resolve.isError ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {resolve.error.message}
        </p>
      ) : null}
    </li>
  );
}

function AmbiguityRow({
  finding,
  byId,
}: {
  readonly finding: AmbiguityFinding;
  readonly byId: ReadonlyMap<string, RequirementItem>;
}) {
  const resolve = useResolveFinding('ambiguity');

  return (
    <li className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted">{byId.get(finding.itemId)?.key ?? ''}</p>
      <p className="text-sm">
        <span className="font-medium">“{finding.phrase}”</span> — {finding.why}
      </p>

      {finding.suggestion ? (
        <p className="mt-2 rounded-md border border-border bg-surface-raised p-2 text-xs">
          <span className="font-medium">A clearer version might say:</span> {finding.suggestion}
          <br />
          <span className="text-muted">
            A suggestion only. Nothing has been changed — edit the requirement yourself if you
            agree.
          </span>
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              findingId: finding.id,
              status: 'resolved',
              expectedVersion: finding.version,
            })
          }
        >
          I have fixed it
        </Button>
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              findingId: finding.id,
              status: 'dismissed',
              expectedVersion: finding.version,
            })
          }
        >
          Clear enough
        </Button>
      </div>
    </li>
  );
}

function GapRow({
  finding,
  byId,
}: {
  readonly finding: MissingInfoFinding;
  readonly byId: ReadonlyMap<string, RequirementItem>;
}) {
  const resolve = useResolveFinding('gap');

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={finding.blocksImplementation ? 'warning' : 'neutral'}>
          {MISSING_DIMENSION_LABELS[finding.dimension]}
        </Badge>
        {finding.itemId ? (
          <span className="font-mono text-xs text-muted">{byId.get(finding.itemId)?.key}</span>
        ) : null}
        {finding.blocksImplementation ? <Badge tone="danger">Blocks approval</Badge> : null}
      </div>

      <p className="mt-2 text-sm">{finding.why}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              findingId: finding.id,
              status: 'resolved',
              expectedVersion: finding.version,
            })
          }
        >
          I have filled it in
        </Button>
        <Button
          variant="secondary"
          disabled={resolve.isPending}
          onClick={() =>
            resolve.mutate({
              findingId: finding.id,
              status: 'accepted_risk',
              expectedVersion: finding.version,
            })
          }
        >
          Accept as a known risk
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted">
        Nothing has been assumed on your behalf. A missing detail stays missing until somebody
        supplies it.
      </p>
    </li>
  );
}
