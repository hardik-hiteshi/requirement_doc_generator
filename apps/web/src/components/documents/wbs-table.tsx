'use client';

import { useState } from 'react';
import {
  DEPENDENCY_TYPE_LABELS,
  ESTIMATION_ROLE_LABELS,
  WBS_LEVEL_LABELS,
  WBS_TASK_STATUS_LABELS,
  WBS_WORK_KIND_LABELS,
  isStandardRole,
  type DocumentRow,
  type DocumentSnapshot,
  type DocumentType,
  type WorkPackage,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { useRegenerateRow, useUpdateRow } from '@/hooks/use-documents';

/**
 * The work breakdown, as an outline somebody can plan against.
 *
 * ## The reconciliation is the headline
 *
 * It is the first thing on screen, before any row. "These 340 hours are the 340 hours
 * you approved, role by role" is the fact that makes the rest of the document worth
 * reading, and when it is *not* true that is the most important thing here — so it is
 * stated either way rather than only when something is wrong.
 *
 * ## Indented, not paginated
 *
 * A breakdown is a shape as much as a list: what sits under what, and which chain
 * cannot slip. Indentation carries the hierarchy, containers show their rolled-up
 * totals, and the critical path is marked on the row rather than in a legend.
 *
 * ## What can be edited here, and what says where to go instead
 *
 * Wording, yes. Hours and days, no — and the refusal names the estimation step rather
 * than simply disabling the field, because "you cannot change this" and "this is
 * changed over there, and here is why" are very different messages to somebody who has
 * spotted a real problem.
 */
export function WbsTable({
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
  const updateRow = useUpdateRow(type);
  const regenerateRow = useRegenerateRow(type);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ task: string; description: string; deliverable: string }>({
    task: '',
    description: '',
    deliverable: '',
  });

  const reconciliation = document.wbsReconciliation;
  const coverage = document.wbsCoverage;
  const rows = document.rows;
  /*
   * Client dependencies that name each task, derived from the current sheet.
   *
   * The sheet owns the relationship; this is the reverse view, so somebody reading a
   * task can see what it is waiting on without the breakdown having been rewritten when
   * the sheet was generated.
   */
  const reverse = document.reverseDependencies;

  const packageOf = (row: DocumentRow): WorkPackage => row.payload as WorkPackage;

  const roleLabel = (role: string): string =>
    isStandardRole(role) ? ESTIMATION_ROLE_LABELS[role] : role;

  const startEditing = (row: DocumentRow): void => {
    const entry = packageOf(row);

    setEditing(row.rowId);
    setDraft({
      task: entry.task,
      description: entry.description,
      deliverable: entry.deliverable,
    });
  };

  return (
    <Card role="region" aria-label="Work breakdown structure">
      <CardHeader>
        <CardTitle>Work breakdown</CardTitle>
        <CardDescription>
          The plan you approved during estimation, arranged as work somebody can pick up. The hours,
          the working days and the critical path are copied from it — they are not recalculated
          here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {reconciliation ? (
          <div
            className={`rounded-md border p-3 text-sm ${
              reconciliation.reconciles ? 'border-border' : 'border-danger'
            }`}
            data-testid="wbs-reconciliation"
          >
            {reconciliation.reconciles ? (
              <p>
                <Badge tone="success" data-testid="wbs-reconciled">
                  Adds up
                </Badge>{' '}
                {reconciliation.wbsTotal} hours across this breakdown, matching the approved
                estimate for every role.
              </p>
            ) : (
              <div className="flex flex-col gap-1" data-testid="wbs-not-reconciled">
                <p role="alert">
                  <Badge tone="danger">Does not add up</Badge> This breakdown totals{' '}
                  {reconciliation.wbsTotal} hours against an approved {reconciliation.approvedTotal}
                  .
                </p>
                {reconciliation.mismatchedRoles.map((entry) => (
                  <p key={entry.role} className="text-xs text-muted">
                    {roleLabel(entry.role)}: {entry.inWbs} here, {entry.approved} approved.
                  </p>
                ))}
                {reconciliation.unmappedEstimateUnitIds.length > 0 ? (
                  <p className="text-xs text-muted">
                    {reconciliation.unmappedEstimateUnitIds.length} priced item has no task against
                    it.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ) : null}

        {coverage ? (
          <p className="text-sm" data-testid="wbs-coverage">
            {coverage.mappedFeatures} of {coverage.applicableFeatures} approved{' '}
            {coverage.applicableFeatures === 1 ? 'feature' : 'features'} covered ·{' '}
            {coverage.mappedRequirements} of {coverage.applicableRequirements} priced{' '}
            {coverage.applicableRequirements === 1 ? 'requirement' : 'requirements'} ·{' '}
            {coverage.overheadWbsIds.length} delivery-overhead{' '}
            {coverage.overheadWbsIds.length === 1 ? 'task' : 'tasks'} ({coverage.overheadHours} h)
            {coverage.unmappedFeatureIds.length > 0 ? (
              <>
                {' · '}
                <span className="text-danger" data-testid="wbs-unmapped-features">
                  {coverage.unmappedFeatureIds.length} agreed{' '}
                  {coverage.unmappedFeatureIds.length === 1 ? 'feature has' : 'features have'} no
                  work against {coverage.unmappedFeatureIds.length === 1 ? 'it' : 'them'}
                </span>
              </>
            ) : null}
          </p>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted" data-testid="wbs-empty">
            This breakdown has not been written yet.
          </p>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="wbs-rows">
            {rows.map((row) => {
              const entry = packageOf(row);
              const depth = entry.wbsId.split('.').length - 1;
              const isTask = entry.level === 'TASK';

              return (
                <li
                  key={row.rowId}
                  className="rounded-md border border-border p-3"
                  style={{ marginInlineStart: `${depth * 1.25}rem` }}
                  data-testid={`wbs-row-${entry.wbsId}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-muted">{entry.wbsId}</span>
                      <span className={isTask ? 'text-sm' : 'text-sm font-medium'}>
                        {isTask ? entry.task : entry.description || entry.feature || entry.module}
                      </span>
                      <Badge tone="neutral">{WBS_LEVEL_LABELS[entry.level]}</Badge>
                      {entry.onCriticalPath ? (
                        <Badge tone="warning" data-testid={`wbs-critical-${entry.wbsId}`}>
                          On the critical path
                        </Badge>
                      ) : null}
                      {entry.parallelizable ? (
                        <Badge tone="neutral" data-testid={`wbs-parallel-${entry.wbsId}`}>
                          Can run alongside
                        </Badge>
                      ) : null}
                      {entry.status === 'EXCLUDED' ? (
                        <Badge tone="neutral">{WBS_TASK_STATUS_LABELS.EXCLUDED}</Badge>
                      ) : null}
                    </span>

                    <span className="text-xs text-muted" data-testid={`wbs-hours-${entry.wbsId}`}>
                      {entry.totalEffort} h
                      {entry.relativeStartDay !== undefined
                        ? ` · days ${entry.relativeStartDay}–${entry.relativeFinishDay}`
                        : ''}
                      {/*
                       * Dates only when the approved plan has them. A project with no
                       * agreed start has a real schedule in working days, and a date
                       * here would be a promise nobody made.
                       */}
                      {entry.actualStartDate
                        ? ` · ${entry.actualStartDate} to ${entry.actualFinishDate}`
                        : ''}
                    </span>
                  </div>

                  {isTask ? (
                    <div className="mt-2 flex flex-col gap-1 text-xs text-muted">
                      <span>
                        {Object.entries(entry.effort)
                          .filter(([, hours]) => hours > 0)
                          .map(([role, hours]) => `${roleLabel(role)} ${hours} h`)
                          .join(' · ')}
                      </span>
                      {entry.deliverable ? <span>Produces: {entry.deliverable}</span> : null}
                      {entry.predecessors.length > 0 ? (
                        <span data-testid={`wbs-predecessors-${entry.wbsId}`}>
                          After {entry.predecessors.join(', ')}
                          {entry.dependencyType
                            ? ` (${DEPENDENCY_TYPE_LABELS[entry.dependencyType].toLowerCase()})`
                            : ''}
                        </span>
                      ) : null}
                      {entry.requirementIds.length > 0 ? (
                        <span>Covers {entry.requirementIds.join(', ')}</span>
                      ) : null}
                      {entry.featureIds.length > 0 ? (
                        <span data-testid={`wbs-features-${entry.wbsId}`}>
                          Delivers {entry.featureIds.length}{' '}
                          {entry.featureIds.length === 1 ? 'agreed feature' : 'agreed features'}
                        </span>
                      ) : null}
                      {entry.workKind === 'OVERHEAD' ? (
                        <span data-testid={`wbs-overhead-${entry.wbsId}`}>
                          {WBS_WORK_KIND_LABELS.OVERHEAD} — supports delivery rather than one
                          feature
                        </span>
                      ) : null}
                      {entry.slackDays !== undefined && entry.slackDays > 0 ? (
                        <span>
                          Could slip {entry.slackDays} working days without moving the end
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {editing === row.rowId ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <label className="flex flex-col gap-1 text-xs">
                        What the task is called
                        <input
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={draft.task}
                          onChange={(event) => setDraft({ ...draft, task: event.target.value })}
                          data-testid={`wbs-task-input-${entry.wbsId}`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        What it involves
                        <textarea
                          rows={3}
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={draft.description}
                          onChange={(event) =>
                            setDraft({ ...draft, description: event.target.value })
                          }
                          data-testid={`wbs-description-input-${entry.wbsId}`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs">
                        What it produces
                        <input
                          className="rounded-md border border-border bg-surface p-2 text-sm"
                          value={draft.deliverable}
                          onChange={(event) =>
                            setDraft({ ...draft, deliverable: event.target.value })
                          }
                          data-testid={`wbs-deliverable-input-${entry.wbsId}`}
                        />
                      </label>
                      <p className="text-xs text-muted">
                        Hours, working days and the critical path come from the estimate you
                        approved. Change them there and regenerate, so one plan stays the plan.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={updateRow.isPending}
                          data-testid={`wbs-save-${entry.wbsId}`}
                          onClick={() => {
                            void updateRow
                              .mutateAsync({
                                rowId: row.rowId,
                                payload: { ...entry, ...draft },
                                expectedVersion: document.recordVersion,
                              })
                              .then(() => setEditing(null));
                          }}
                        >
                          Save
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => setEditing(null)}
                          data-testid={`wbs-cancel-${entry.wbsId}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {editable && isTask && editing !== row.rowId ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => startEditing(row)}
                        data-testid={`wbs-edit-${entry.wbsId}`}
                      >
                        Reword
                      </Button>
                      {aiAvailable ? (
                        <Button
                          variant="secondary"
                          disabled={regenerateRow.isPending}
                          data-testid={`wbs-regenerate-${entry.wbsId}`}
                          onClick={() => {
                            void regenerateRow.mutateAsync({
                              rowId: row.rowId,
                              useAi: true,
                              expectedVersion: document.recordVersion,
                            });
                          }}
                        >
                          Reword with AI
                        </Button>
                      ) : null}
                    </div>
                  ) : null}

                  {/*
                   * What this task waits on, and how much to trust the answer. A stale
                   * sheet is still worth showing — the dependency probably still exists
                   * — but saying so is the difference between a useful link and a
                   * current claim the breakdown cannot support.
                   */}
                  {(reverse?.byWbsId[entry.wbsId] ?? []).length > 0 ? (
                    <div
                      className="mt-2 flex flex-col gap-1 text-xs"
                      data-testid={`wbs-dependencies-${entry.wbsId}`}
                    >
                      {reverse!.byWbsId[entry.wbsId]!.map((related) => (
                        <span
                          key={related.dependencyKey}
                          className="flex flex-wrap items-baseline gap-1"
                        >
                          <span
                            className={related.blockingOutstanding ? 'text-danger' : 'text-muted'}
                          >
                            Waiting on {related.dependencyKey}: {related.dependency}
                          </span>
                          {related.blockingOutstanding ? (
                            <Badge tone="danger">Outstanding</Badge>
                          ) : null}
                          {related.sheetCurrentness === 'OUTDATED' ? (
                            <Badge
                              tone="warning"
                              data-testid={`wbs-dependency-stale-${entry.wbsId}`}
                            >
                              From a dependency sheet that is out of date
                            </Badge>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {row.proposed ? (
                    <p
                      className="mt-2 text-xs text-muted"
                      data-testid={`wbs-proposal-${entry.wbsId}`}
                    >
                      A suggested rewrite is waiting on this row.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        {updateRow.isError ? (
          <p role="alert" className="text-sm text-danger" data-testid="wbs-error">
            {updateRow.error.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
