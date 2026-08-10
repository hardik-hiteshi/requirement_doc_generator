'use client';

import {
  CSV_ROLE_COLUMNS,
  DOCUMENT_ERROR_MESSAGES,
  OTHER_ROLE_LABELS,
  otherRoleEffort,
  type DocumentSnapshot,
  type DocumentType,
  type FeatureRow,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useFeatureCsv,
  useRegenerateFeature,
  useRegenerateModule,
  useResolveFeatureProposal,
  useUpdateFeature,
} from '@/hooks/use-documents';

/**
 * The Feature Listing as a table, which is how anybody actually reviews one.
 *
 * Two things about it are deliberate.
 *
 * **The hours are not inputs.** They are rendered as text, and the panel says
 * where they come from. A number in a text box invites an edit that the API would
 * then refuse — and the honest design is not to offer it.
 *
 * **Coverage is a figure with its working shown.** "84%" alone is a number
 * somebody will round up in conversation; beside it are how many requirements are
 * represented, how many were deliberately excluded, and how many nobody has
 * decided about yet.
 */
export function FeatureTable({
  type,
  document,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showCsv, setShowCsv] = useState(false);
  const [copied, setCopied] = useState(false);
  const [module, setModule] = useState('');
  const update = useUpdateFeature(type);
  const regenerateFeature = useRegenerateFeature(type);
  const regenerateModule = useRegenerateModule(type);
  const resolve = useResolveFeatureProposal(type);
  const csv = useFeatureCsv(type, showCsv);

  const coverage = document.coverage;
  const modules = [...new Set(document.features.map((row) => row.module))].sort();

  return (
    <Card role="region" aria-label="Feature listing">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Features</CardTitle>
          <Badge tone={coverage && coverage.unresolved > 0 ? 'warning' : 'success'}>
            <span data-testid="feature-coverage">{coverage?.percentage ?? 0}% covered</span>
          </Badge>
        </div>
        <CardDescription>
          One row per feature. The hours are the ones you approved in the estimate — they are
          changed there, not here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {coverage ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Applicable requirements</dt>
              <dd data-testid="coverage-applicable">{coverage.applicable}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">In a feature</dt>
              <dd data-testid="coverage-represented">{coverage.represented}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Deliberately excluded</dt>
              <dd data-testid="coverage-excluded">{coverage.excluded}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Nobody has decided</dt>
              <dd data-testid="coverage-unresolved">{coverage.unresolved}</dd>
            </div>
          </dl>
        ) : null}

        {document.reconciliation ? (
          <p className="text-xs text-muted" data-testid="feature-reconciliation">
            {document.reconciliation.reconciles
              ? `These rows total ${document.reconciliation.documentHours} hours, matching the approved estimate exactly.`
              : `These rows total ${document.reconciliation.documentHours} hours against ${document.reconciliation.estimateHours} in the approved estimate. Regenerate to bring them back in step.`}
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="feature-table">
            <thead>
              <tr className="border-b border-border text-xs text-muted">
                <th className="p-2">Module</th>
                <th className="p-2">Sub module</th>
                <th className="p-2">Screen</th>
                <th className="p-2">Feature</th>
                <th className="p-2">Backend</th>
                <th className="p-2">Frontend</th>
                <th className="p-2">QA</th>
                <th className="p-2">Other roles</th>
                <th className="p-2">Requirements</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {document.features.map((row) => (
                <FeatureRowView
                  key={row.featureId}
                  row={row}
                  editing={editing === row.featureId}
                  onEdit={() => setEditing(row.featureId)}
                  onCancel={() => setEditing(null)}
                  onSave={(fields) =>
                    update.mutate(
                      {
                        featureId: row.featureId,
                        ...fields,
                        expectedVersion: document.recordVersion,
                      },
                      { onSuccess: () => setEditing(null) },
                    )
                  }
                  onRegenerate={() =>
                    regenerateFeature.mutate({
                      featureId: row.featureId,
                      useAi: true,
                      expectedVersion: document.recordVersion,
                    })
                  }
                  onResolve={(decision) =>
                    resolve.mutate({
                      featureId: row.featureId,
                      decision,
                      expectedVersion: document.recordVersion,
                    })
                  }
                  saving={update.isPending || regenerateFeature.isPending || resolve.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>

        {document.features.length === 0 ? (
          <p className="text-sm text-muted">No features yet. Generate the listing to see them.</p>
        ) : null}

        {update.isError ? (
          <p role="alert" className="text-sm text-danger" data-testid="feature-error">
            {update.error.message}
          </p>
        ) : null}

        {modules.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Rewrite one module</span>
              <span className="text-muted">
                Only that module’s rows are rewritten. Everything else — wording, review state and
                every hours figure — is carried forward exactly as it is.
              </span>
              <select
                value={module}
                onChange={(event) => setModule(event.target.value)}
                className="rounded-md border border-border px-2 py-1 text-sm"
                aria-label="Module to rewrite"
                data-testid="module-select"
              >
                <option value="">Choose a module</option>
                {modules.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              className="self-start"
              disabled={module.length === 0 || regenerateModule.isPending}
              data-testid="regenerate-module"
              onClick={() =>
                regenerateModule.mutate(
                  { module, useAi: true, expectedVersion: document.recordVersion },
                  { onSuccess: () => setModule('') },
                )
              }
            >
              Rewrite this module
            </Button>
            {regenerateModule.isError ? (
              <p role="alert" className="text-xs text-danger" data-testid="module-error">
                {regenerateModule.error.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">{DOCUMENT_ERROR_MESSAGES.EFFORT_NOT_EDITABLE_HERE}</p>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => setShowCsv((open) => !open)}
            data-testid="toggle-csv"
          >
            {showCsv ? 'Hide the export preview' : 'Preview the export'}
          </Button>
          {showCsv ? (
            <div className="flex flex-col gap-2">
              <pre
                className="overflow-x-auto rounded-md border border-border p-3 text-xs"
                data-testid="csv-preview"
              >
                {csv.data?.csv ?? 'Loading…'}
              </pre>
              {csv.data ? (
                <>
                  <Button
                    variant="secondary"
                    className="self-start"
                    data-testid="copy-csv"
                    onClick={() => {
                      void navigator.clipboard?.writeText(csv.data.csv).then(() => setCopied(true));
                    }}
                  >
                    Copy to clipboard
                  </Button>
                  <p className="text-xs text-muted" data-testid="csv-copy-note">
                    {copied
                      ? 'Copied — the eight columns exactly, every value quoted.'
                      : 'Copies the export exactly: eight columns, in order, every value quoted.'}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function FeatureRowView({
  row,
  editing,
  onEdit,
  onCancel,
  onSave,
  onRegenerate,
  onResolve,
  saving,
}: {
  readonly row: FeatureRow;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onSave: (fields: {
    module: string;
    submodule: string;
    screen: string;
    description: string;
  }) => void;
  readonly onRegenerate: () => void;
  readonly onResolve: (
    decision: 'KEEP_CURRENT' | 'ACCEPT_GENERATED_REVISION' | 'EDIT_GENERATED_REVISION',
  ) => void;
  readonly saving: boolean;
}) {
  const [module, setModule] = useState(row.module);
  const [submodule, setSubmodule] = useState(row.submodule);
  const [screen, setScreen] = useState(row.screen);
  const [description, setDescription] = useState(row.description);

  if (editing) {
    return (
      <tr className="border-b border-border" data-testid={`feature-edit-${row.featureId}`}>
        <td className="p-2">
          <input
            value={module}
            onChange={(event) => setModule(event.target.value)}
            aria-label="Module"
            className="w-full rounded-md border border-border px-2 py-1"
            data-testid="feature-module-input"
          />
        </td>
        <td className="p-2">
          <input
            value={submodule}
            onChange={(event) => setSubmodule(event.target.value)}
            aria-label="Sub module"
            className="w-full rounded-md border border-border px-2 py-1"
          />
        </td>
        <td className="p-2">
          <input
            value={screen}
            onChange={(event) => setScreen(event.target.value)}
            aria-label="Screen"
            className="w-full rounded-md border border-border px-2 py-1"
          />
        </td>
        <td className="p-2" colSpan={5}>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label="Feature description"
            rows={3}
            className="w-full rounded-md border border-border px-2 py-1"
          />
        </td>
        <td className="p-2 text-xs text-muted">{row.requirementIds.join(', ')}</td>
        <td className="p-2">
          <div className="flex flex-col gap-1">
            <Button
              onClick={() => onSave({ module, submodule, screen, description })}
              disabled={saving}
              data-testid="feature-save"
            >
              Save
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border" data-testid={`feature-row-${row.featureId}`}>
      <td className="p-2">{row.module}</td>
      <td className="p-2">{row.submodule}</td>
      {/* Legitimately empty for work with no interface. */}
      <td className="p-2" data-testid={`feature-screen-${row.featureId}`}>
        {row.screen || <span className="text-muted">—</span>}
      </td>
      <td className="p-2">{row.description}</td>
      {CSV_ROLE_COLUMNS.map((role) => (
        <td
          key={role}
          className="p-2"
          data-testid={`feature-${role.toLowerCase()}-${row.featureId}`}
        >
          {row.effort[role] ?? '—'}
        </td>
      ))}
      <td className="p-2 text-xs" data-testid={`feature-other-${row.featureId}`}>
        {otherRoleEffort(row.effort)
          .map(({ role, hours }) => `${OTHER_ROLE_LABELS[role] ?? role}: ${hours}`)
          .join(' | ') || '—'}
      </td>
      <td className="p-2 text-xs text-muted">{row.requirementIds.join(', ')}</td>
      <td className="p-2">
        <div className="flex flex-col gap-1">
          <Button
            variant="secondary"
            onClick={onEdit}
            data-testid={`feature-edit-button-${row.featureId}`}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            onClick={onRegenerate}
            disabled={saving}
            data-testid={`feature-regenerate-${row.featureId}`}
          >
            Rewrite
          </Button>
          {row.proposed ? (
            <div
              className="flex flex-col gap-1 rounded-md border border-warning p-2"
              data-testid={`feature-proposal-${row.featureId}`}
            >
              <p className="text-xs font-medium">Suggested wording</p>
              <p className="text-xs text-muted">
                {row.proposed.module} — {row.proposed.screen || 'no screen'}
              </p>
              <p className="text-xs text-muted">{row.proposed.description}</p>
              <Button
                variant="secondary"
                disabled={saving}
                data-testid={`feature-keep-${row.featureId}`}
                onClick={() => onResolve('KEEP_CURRENT')}
              >
                Keep mine
              </Button>
              <Button
                variant="secondary"
                disabled={saving}
                data-testid={`feature-accept-${row.featureId}`}
                onClick={() => onResolve('ACCEPT_GENERATED_REVISION')}
              >
                Use the suggestion
              </Button>
            </div>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
