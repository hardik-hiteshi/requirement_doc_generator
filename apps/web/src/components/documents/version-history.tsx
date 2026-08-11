'use client';

import type { DocumentSnapshot, DocumentType } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useDocumentDiff, useDocumentVersions, useRestoreVersion } from '@/hooks/use-documents';

/**
 * Every version, what changed between two of them, and restoring one.
 *
 * Restoring copies forward as a new version rather than rewinding, and the panel
 * says so — otherwise "restore" reads like an undo, and somebody will expect the
 * version they were on to disappear.
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
                <span className="text-xs text-muted">
                  {version.contentCount} {document.features.length > 0 ? 'rows' : 'sections'}
                  {version.userEditedCount > 0 ? `, ${version.userEditedCount} yours` : ''}
                  {version.regenerationReason ? ` — ${version.regenerationReason}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{version.status}</Badge>
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
                        {entry.left ? (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted">
                            Before: {entry.left}
                          </p>
                        ) : null}
                        {entry.right ? (
                          <p className="mt-1 whitespace-pre-wrap text-xs">After: {entry.right}</p>
                        ) : null}
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
