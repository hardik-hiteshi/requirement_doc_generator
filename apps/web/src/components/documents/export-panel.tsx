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

import { downloadDocumentExport } from '@/lib/documents-api';

/**
 * Downloading the document that is open, in the formats it supports.
 *
 * Only the supported formats appear. An unavailable one is not rendered as a disabled
 * button, following the same reasoning the output-preferences screen already uses: a
 * control that exists but cannot be used invites "why not?" on every visit.
 *
 * The version being exported is stated rather than implied. When somebody is looking at
 * version 3 of a document that has since moved to 5, the file they get is version 3, and
 * a download that quietly gave them the latest instead would be worse than useless.
 *
 * Export is read-only and says so. The workflow is not locked while a file is generated,
 * because nothing about the document is changing — only the button that was pressed goes
 * quiet, so a second impatient click does not start a second render.
 */
export function ExportPanel({
  type,
  document,
  version,
}: {
  readonly type: DocumentType;
  readonly document: DocumentSnapshot;
  /** The version on screen. Undefined means the working version. */
  readonly version?: number;
}) {
  const [busy, setBusy] = useState<ExportFormat | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const formats = exportFormatsFor(type);
  const exportedVersion = version ?? document.version;
  const outdated = document.currentness === 'OUTDATED';

  async function download(format: ExportFormat): Promise<void> {
    setError(undefined);
    setBusy(format);

    try {
      await downloadDocumentExport(type, format, version);
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
          Downloading does not change the document. The file is generated from the version shown
          below, exactly as it stands.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" data-testid="export-version">
            v{exportedVersion}
          </Badge>
          <Badge tone={outdated ? 'warning' : 'neutral'} data-testid="export-status">
            {DOCUMENT_STATUS_LABELS[document.status]}
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
