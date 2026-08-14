'use client';

import {
  DOCUMENT_STATUS_LABELS,
  exportFormatsFor,
  type DocumentSnapshot,
  type DocumentType,
  type ExportFormat,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useDocumentVersions } from '@/hooks/use-documents';
import { downloadDocumentExport } from '@/lib/documents-api';

/**
 * Downloading a version of the document that is open, in the formats it supports.
 *
 * Only the supported formats appear. An unavailable one is not rendered as a disabled
 * button, following the same reasoning the output-preferences screen already uses: a
 * control that exists but cannot be used invites "why not?" on every visit.
 *
 * ## Any version, without restoring it
 *
 * The version to download is chosen here, not implied by what happens to be on screen.
 * Somebody who needs the copy that was issued in March needs that file, and making them
 * restore March over the current draft to get it would destroy the thing they were
 * working on to retrieve a download. So the archive is offered directly, and the badges
 * describe the version selected rather than the working one — a v2 draft must not be
 * presented as approved because v5 happens to be.
 *
 * Export is read-only and says so. The workflow is not locked while a file is generated,
 * because nothing about the document is changing — only the buttons go quiet, so a second
 * impatient click does not start a second render.
 */
export function ExportPanel({
  type,
  document,
  version,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
  /** A version to offer first. Undefined means the working one. */
  readonly version?: number;
}) {
  const [busy, setBusy] = useState<ExportFormat | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(version);

  const versions = useDocumentVersions(type);
  const formats = exportFormatsFor(type);

  const working = document.version;
  const exportedVersion = selected ?? working;

  /*
   * The archive plus the working version, newest first.
   *
   * The document on screen is the authority for its own version, and the history list is
   * not: it is a separate read that can lag a change, and "this version is out of date" has
   * to appear the moment the document says so. So the working version comes from the
   * snapshot and the list supplies only the versions behind it.
   */
  const archived = versions.data?.versions ?? [];
  const offered = [
    { version: working, status: document.status, currentness: document.currentness },
    ...archived
      .filter((entry) => entry.version !== working)
      .map((entry) => ({
        version: entry.version,
        status: entry.status,
        currentness: entry.currentness,
      })),
  ].sort((left, right) => right.version - left.version);

  const chosen = offered.find((entry) => entry.version === exportedVersion);
  const status = chosen?.status ?? document.status;
  const outdated = (chosen?.currentness ?? document.currentness) === 'OUTDATED';

  async function download(format: ExportFormat): Promise<void> {
    setError(undefined);
    setBusy(format);

    try {
      /* The working version is requested without a number, as the live document. */
      await downloadDocumentExport(
        type,
        format,
        exportedVersion === working ? undefined : exportedVersion,
      );
    } catch (caught) {
      /*
       * A renderer failing is not a document failing. The document is untouched, so the
       * message says what to do — try again — and nothing about the workflow changes.
       */
      setError(
        caught instanceof Error
          ? caught.message
          : 'The file could not be produced. The document is unchanged — try again.',
      );
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card role="region" aria-label="Download">
      <CardHeader>
        <CardTitle>Download</CardTitle>
        <CardDescription>
          Downloading does not change the document. The file is generated from the version selected
          below, exactly as it stands.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {offered.length > 1 && (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Version to download</span>
            <select
              className="rounded-md border border-border bg-surface px-2 py-1"
              value={exportedVersion}
              onChange={(event) => setSelected(Number(event.target.value))}
              data-testid="export-version-select"
            >
              {offered.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  v{entry.version}
                  {entry.version === working ? ' (current)' : ''} —{' '}
                  {DOCUMENT_STATUS_LABELS[entry.status]}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" data-testid="export-version">
            v{exportedVersion}
          </Badge>
          <Badge tone={outdated ? 'warning' : 'neutral'} data-testid="export-status">
            {DOCUMENT_STATUS_LABELS[status]}
          </Badge>
          {outdated && (
            <span className="text-sm text-muted" data-testid="export-outdated-note">
              This version is out of date. The file will say so.
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {formats.map((format) => (
            <Button
              key={format}
              variant="secondary"
              onClick={() => void download(format)}
              disabled={busy !== undefined}
              data-testid={`export-${format}`}
            >
              {busy === format ? `Preparing ${format}…` : format}
            </Button>
          ))}
        </div>

        {error && (
          <p className="text-sm text-danger" role="alert" data-testid="export-error">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
