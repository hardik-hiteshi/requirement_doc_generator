'use client';

import {
  DIFF_CHANGE_KIND_LABELS,
  DOCUMENT_CHANGE_TYPE_LABELS,
  type DocumentSnapshot,
  type DocumentType,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useDocumentDiff, useDocumentVersions, useRestoreVersion } from '@/hooks/use-documents';

/**
 * Every version, what changed between two of them, and restoring one.
 *
 * Restoring copies forward as a new version rather than rewinding, and the panel
 * says so — otherwise "restore" reads like an undo, and somebody will expect the
 * version they were on to disappear.
 *
 * ## Each version says what it is, not just when it was
 *
 * A list of nine numbered versions with timestamps is not a history: nobody can find
 * the one they want in it. So each row says what produced it — an edit, a rewrite, an
 * approval, content brought back from an earlier version — and where it came from where
 * that applies. Approved and issued versions are marked, because those are the two
 * somebody is usually looking for.
 *
 * ## A row diff shows the fields, not the row
 *
 * "This entry changed" is not useful when a row has a dozen fields and one of them is
 * the hours somebody will plan against. Each changed field is listed with both values
 * and what kind of change it is, so the difference between a rewording and a moved
 * citation is visible at a glance.
 *
 * Old and new are stacked rather than side by side. A phone cannot show two columns of
 * prose, and understanding a change should not require scrolling sideways.
 */
export function VersionHistory({
  type,
  document,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
}) {
  const versions = useDocumentVersions(type);
  const restore = useRestoreVersion(type);
  const [left, setLeft] = useState<number | null>(null);
  const [right, setRight] = useState<number | null>(null);
  const diff = useDocumentDiff(type, left, right);

  const list = versions.data?.versions ?? [];

  return (
    <Card role="region" aria-label="Document versions">
      <CardHeader>
        <CardTitle>Versions</CardTitle>
        <CardDescription>
          Every version is kept exactly as it was. Restoring brings one back as a new version — it
          never removes the one you are on.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2" data-testid="version-list">
          {list.map((version) => (
            <li
              key={version.version}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
              data-testid={`version-${version.version}`}
            >
              <div className="flex flex-col">
                <span className="font-medium">
                  Version {version.version}
                  {version.version === document.version ? ' — current' : ''}
                </span>
                <span
                  className="text-xs text-muted"
                  data-testid={`version-what-${version.version}`}
                >
                  {version.changeType ? DOCUMENT_CHANGE_TYPE_LABELS[version.changeType] : 'Written'}
                  {version.restoredFromVersion !== undefined
                    ? ` from version ${version.restoredFromVersion}`
                    : ''}
                  {version.revisedFromVersion !== undefined
                    ? ` beside version ${version.revisedFromVersion}`
                    : ''}
                  {' · '}
                  {new Date(version.createdAt).toLocaleString()}
                </span>
                <span className="text-xs text-muted">
                  {version.contentCount} {document.sections.length > 0 ? 'sections' : 'entries'}
                  {version.userEditedCount > 0 ? `, ${version.userEditedCount} yours` : ''}
                  {version.regenerationReason ? ` — ${version.regenerationReason}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{version.status}</Badge>
                {/*
                 * The state of that version's inputs, per version. "The one we issued in
                 * March is no longer current" is a fact the history can state without
                 * anybody having edited the March document.
                 */}
                {version.currentness === 'OUTDATED' ? (
                  <Badge tone="warning" data-testid={`version-outdated-${version.version}`}>
                    Inputs have changed since
                  </Badge>
                ) : null}
                {version.approvedAt ? (
                  <Badge tone="success" data-testid={`version-approved-${version.version}`}>
                    Approved
                  </Badge>
                ) : null}
                {version.finalAt ? (
                  <Badge tone="success" data-testid={`version-issued-${version.version}`}>
                    Issued
                  </Badge>
                ) : null}
                <Button
                  variant="secondary"
                  data-testid={`compare-left-${version.version}`}
                  onClick={() => setLeft(version.version)}
                >
                  Compare from
                </Button>
                <Button
                  variant="secondary"
                  data-testid={`compare-right-${version.version}`}
                  onClick={() => setRight(version.version)}
                >
                  Compare to
                </Button>
                {version.version === document.version ? null : (
                  <Button
                    variant="secondary"
                    disabled={restore.isPending}
                    data-testid={`restore-${version.version}`}
                    onClick={() =>
                      restore.mutate({
                        version: version.version,
                        expectedVersion: document.recordVersion,
                      })
                    }
                  >
                    Restore this one
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>

        {list.length === 0 ? <p className="text-sm text-muted">No versions yet.</p> : null}

        {restore.isError ? (
          <p role="alert" className="text-sm text-danger">
            {restore.error.message}
          </p>
        ) : null}

        {left !== null && right !== null ? (
          <div className="flex flex-col gap-2" data-testid="version-diff">
            <h3 className="text-sm font-medium">
              What changed between version {left} and version {right}
            </h3>
            {left === right ? (
              <p className="text-sm text-muted">Pick two different versions.</p>
            ) : (
              <>
                <p className="text-xs text-muted" data-testid="diff-count">
                  {diff.data?.diff.changedCount ?? 0} changed
                </p>
                <ul className="flex flex-col gap-2">
                  {(diff.data?.diff.entries ?? [])
                    .filter((entry) => entry.kind !== 'UNCHANGED')
                    .map((entry) => (
                      <li
                        key={entry.key}
                        className="rounded-md border border-border p-3 text-sm"
                        data-testid={`diff-${entry.key}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{entry.title}</span>
                          <Badge tone="neutral">{entry.kind}</Badge>
                        </div>
                        {/*
                         * A row's changed fields, where there are any. Stacked old above
                         * new, so a narrow screen reads top to bottom rather than
                         * sideways.
                         */}
                        {entry.fields.length > 0 ? (
                          <ul
                            className="mt-2 flex flex-col gap-2"
                            data-testid={`diff-fields-${entry.key}`}
                          >
                            {entry.fields.map((changed) => (
                              <li key={changed.field} className="flex flex-col gap-1">
                                <span className="flex flex-wrap items-baseline gap-2 text-xs font-medium">
                                  {changed.label}
                                  <Badge tone="neutral">
                                    {DIFF_CHANGE_KIND_LABELS[changed.changeKind]}
                                  </Badge>
                                </span>
                                <span className="whitespace-pre-wrap text-xs text-muted">
                                  Before: {changed.left || '—'}
                                </span>
                                <span className="whitespace-pre-wrap text-xs">
                                  After: {changed.right || '—'}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <>
                            {entry.left ? (
                              <p className="mt-1 whitespace-pre-wrap text-xs text-muted">
                                Before: {entry.left}
                              </p>
                            ) : null}
                            {entry.right ? (
                              <p className="mt-1 whitespace-pre-wrap text-xs">
                                After: {entry.right}
                              </p>
                            ) : null}
                          </>
                        )}
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
