'use client';

import { useState } from 'react';
import {
  criterionText,
  isGherkinShaped,
  CRITERION_ASPECT_LABELS,
  type AcceptanceCriterion,
  type DocumentRow,
  type DocumentSnapshot,
  type DocumentType,
} from '@wdrg/contracts';

import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import {
  useAddRow,
  useExcludeRow,
  useRegenerateRow,
  useRegenerateRowGroup,
  useResolveRowProposal,
  useUpdateRow,
} from '@/hooks/use-documents';

/**
 * The acceptance conditions, as a reviewable list.
 *
 * Each row shows the condition the way a reader would see it — Given/When/Then
 * where the criterion has that shape, a sentence where it does not — beside what it
 * is about and what it is built on. The point of the view is that somebody can
 * agree to a row or reject it without opening anything.
 *
 * A row a person wrote is marked. A row with a suggested rewrite waiting shows both
 * and asks, rather than quietly choosing.
 */
export function CriteriaTable({
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
  const update = useUpdateRow(type);
  const regenerate = useRegenerateRow(type);
  const regenerateGroup = useRegenerateRowGroup(type);
  const resolve = useResolveRowProposal(type);
  const exclude = useExcludeRow(type);
  const add = useAddRow(type);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [group, setGroup] = useState('');
  const [attribution, setAttribution] = useState('');
  const [newCondition, setNewCondition] = useState('');

  const criterionOf = (row: DocumentRow): AcceptanceCriterion => row.payload as AcceptanceCriterion;

  const modules = [...new Set(document.rows.map((row) => criterionOf(row).module).filter(Boolean))];

  const coverage = document.criteriaCoverage;

  return (
    <Card role="region" aria-label="Acceptance criteria">
      <CardHeader>
        <CardTitle>Acceptance criteria</CardTitle>
        <CardDescription>
          What has to be true for this work to be accepted. These are conditions, not test scripts —
          each one is something you could watch happen and agree had happened.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {coverage ? (
          <p className="text-sm" data-testid="criteria-coverage">
            {coverage.complete
              ? `Every approved requirement and feature has a condition, or a recorded decision not to have one — ${coverage.coveredRequirements} of ${coverage.applicableRequirements} requirements, ${coverage.coveredFeatures} of ${coverage.applicableFeatures} features.`
              : `${coverage.uncoveredRequirementIds.length + coverage.uncoveredFeatureIds.length} approved item${
                  coverage.uncoveredRequirementIds.length + coverage.uncoveredFeatureIds.length ===
                  1
                    ? ' has'
                    : 's have'
                } no condition yet.`}
          </p>
        ) : null}

        {editable && modules.length > 1 ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              Rewrite one area
              <select
                className="rounded-md border border-border bg-surface p-2 text-sm"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
                data-testid="criteria-module-select"
              >
                <option value="">Choose an area</option>
                {modules.map((module) => (
                  <option key={module} value={module}>
                    {module}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              disabled={group === '' || regenerateGroup.isPending}
              data-testid="criteria-regenerate-module"
              onClick={() =>
                regenerateGroup.mutate({
                  group,
                  useAi: aiAvailable,
                  expectedVersion: document.recordVersion,
                })
              }
            >
              Rewrite this area
            </Button>
          </div>
        ) : null}

        <ul className="flex flex-col gap-3">
          {document.rows.map((row) => {
            const criterion = criterionOf(row);
            const proposed = row.proposed as AcceptanceCriterion | undefined;

            return (
              <li
                key={row.rowId}
                className="rounded-md border border-border p-3"
                data-testid={`criterion-${criterion.criterionKey}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{criterion.criterionKey}</Badge>
                  <Badge tone="neutral">{CRITERION_ASPECT_LABELS[criterion.aspect]}</Badge>
                  {criterion.module ? (
                    <span className="text-xs text-muted">
                      {criterion.module}
                      {criterion.submodule ? ` · ${criterion.submodule}` : ''}
                      {criterion.screen ? ` · ${criterion.screen}` : ''}
                    </span>
                  ) : null}
                  {row.origin === 'USER_DEFINED' ? (
                    <Badge
                      tone="warning"
                      data-testid={`criterion-user-defined-${criterion.criterionKey}`}
                    >
                      Added by you
                    </Badge>
                  ) : null}
                  {row.origin === 'USER_EDITED' ? <Badge tone="neutral">Your wording</Badge> : null}
                  {row.excludedReason ? <Badge tone="neutral">Deliberately left out</Badge> : null}
                </div>

                {editing === row.rowId ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <textarea
                      className="min-h-24 rounded-md border border-border bg-surface p-2 text-sm"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label={`Condition for ${criterion.criterionKey}`}
                      data-testid={`criterion-input-${criterion.criterionKey}`}
                    />
                    <div className="flex gap-2">
                      <Button
                        disabled={update.isPending}
                        data-testid={`criterion-save-${criterion.criterionKey}`}
                        onClick={() => {
                          void update
                            .mutateAsync({
                              rowId: row.rowId,
                              payload: { then: draft },
                              expectedVersion: document.recordVersion,
                            })
                            .then(() => setEditing(null));
                        }}
                      >
                        Save
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p
                    className="mt-2 whitespace-pre-wrap text-sm"
                    data-testid={`criterion-text-${criterion.criterionKey}`}
                  >
                    {criterionText(criterion)}
                  </p>
                )}

                {criterion.rule ? (
                  <p className="mt-1 text-xs text-muted">Rule: {criterion.rule}</p>
                ) : null}

                {row.attribution ? (
                  <p className="mt-1 text-xs text-muted">Where this came from: {row.attribution}</p>
                ) : null}

                {row.references.length > 0 ? (
                  <details
                    className="mt-2"
                    data-testid={`criterion-sources-${criterion.criterionKey}`}
                  >
                    <summary className="cursor-pointer text-xs text-muted">
                      Where this comes from
                    </summary>
                    <ul className="mt-1 flex flex-col gap-1 text-xs">
                      {row.references.map((reference) => (
                        <li key={`${reference.kind}-${reference.id}`}>
                          {reference.id}
                          {reference.label ? ` — ${reference.label}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {/*
                 * A suggested rewrite sits beside the wording rather than replacing
                 * it. Somebody chose these words, so somebody decides.
                 */}
                {proposed ? (
                  <div
                    className="mt-2 rounded-md border border-warning p-2"
                    data-testid={`criterion-proposal-${criterion.criterionKey}`}
                  >
                    <p className="text-xs font-medium">A rewrite is suggested</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{criterionText(proposed)}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        disabled={resolve.isPending}
                        data-testid={`criterion-keep-${criterion.criterionKey}`}
                        onClick={() =>
                          resolve.mutate({
                            rowId: row.rowId,
                            decision: 'KEEP_CURRENT',
                            expectedVersion: document.recordVersion,
                          })
                        }
                      >
                        Keep mine
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={resolve.isPending}
                        data-testid={`criterion-accept-${criterion.criterionKey}`}
                        onClick={() =>
                          resolve.mutate({
                            rowId: row.rowId,
                            decision: 'ACCEPT_GENERATED_REVISION',
                            expectedVersion: document.recordVersion,
                          })
                        }
                      >
                        Use the new version
                      </Button>
                    </div>
                  </div>
                ) : null}

                {editable ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      data-testid={`criterion-edit-${criterion.criterionKey}`}
                      onClick={() => {
                        setEditing(row.rowId);
                        setDraft(criterion.then);
                      }}
                    >
                      Edit the wording
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={regenerate.isPending}
                      data-testid={`criterion-regenerate-${criterion.criterionKey}`}
                      onClick={() =>
                        regenerate.mutate({
                          rowId: row.rowId,
                          useAi: aiAvailable,
                          expectedVersion: document.recordVersion,
                        })
                      }
                    >
                      Rewrite it
                    </Button>
                    {!row.excludedReason ? (
                      <Button
                        variant="secondary"
                        disabled={exclude.isPending}
                        data-testid={`criterion-exclude-${criterion.criterionKey}`}
                        onClick={() =>
                          exclude.mutate({
                            rowId: row.rowId,
                            reason: 'Deliberately not stating a condition for this.',
                            expectedVersion: document.recordVersion,
                          })
                        }
                      >
                        Leave it out
                      </Button>
                    ) : null}
                    {isGherkinShaped(criterion) ? null : (
                      <span className="self-center text-xs text-muted">
                        Stated as a rule rather than a scenario
                      </span>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {editable ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <h3 className="text-sm font-medium">Add a condition</h3>
            <p className="text-xs text-muted">
              A condition you add is marked as yours. Say where it came from — a condition nobody
              can trace cannot be agreed.
            </p>
            <label className="flex flex-col gap-1 text-xs">
              What has to be true
              <textarea
                className="min-h-16 rounded-md border border-border bg-surface p-2 text-sm"
                value={newCondition}
                onChange={(event) => setNewCondition(event.target.value)}
                data-testid="criterion-new-text"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Where it came from
              <input
                className="rounded-md border border-border bg-surface p-2 text-sm"
                value={attribution}
                onChange={(event) => setAttribution(event.target.value)}
                data-testid="criterion-new-attribution"
              />
            </label>
            <Button
              className="self-start"
              disabled={add.isPending || newCondition.trim() === '' || attribution.trim() === ''}
              data-testid="criterion-add"
              onClick={() => {
                void add
                  .mutateAsync({
                    payload: {
                      criterionKey: 'AC-000',
                      requirementIds: [],
                      featureIds: [],
                      module: '',
                      submodule: '',
                      screen: '',
                      actor: '',
                      aspect: 'BEHAVIOUR',
                      given: '',
                      when: '',
                      then: newCondition.trim(),
                      rule: '',
                      requiresProcedure: false,
                      status: 'DRAFT',
                      notes: '',
                    },
                    attribution: attribution.trim(),
                    expectedVersion: document.recordVersion,
                  })
                  .then(() => {
                    setNewCondition('');
                    setAttribution('');
                  });
              }}
            >
              Add it
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
