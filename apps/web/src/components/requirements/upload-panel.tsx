'use client';

import {
  FILE_PICKER_ACCEPT,
  SUPPORTED_EXTENSIONS,
  type SourceListResponse,
  type UploadOutcome,
} from '@wdrg/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useRef, useState } from 'react';

import { uploadFiles } from '@/lib/requirements-api';
import { useRefreshSources } from '@/hooks/use-sources';

export interface UploadPanelProps {
  readonly usage: SourceListResponse['usage'];
}

/**
 * Drag-and-drop and file-picker upload.
 *
 * Both routes exist because both are how people actually attach files, and a
 * drop zone alone is unusable with a keyboard. The picker is a real `<input
 * type="file">` — visually hidden, not replaced — so it keeps its native
 * keyboard behaviour and its accessible name.
 *
 * Outcomes are shown per file. A batch where two of five were rejected must say
 * *which* two and why, not "some files failed".
 */
export function UploadPanel({ usage }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [outcomes, setOutcomes] = useState<UploadOutcome[]>([]);
  const [error, setError] = useState<string | undefined>();
  const refresh = useRefreshSources();

  const atFileLimit = usage.fileCount >= usage.maxFiles;
  const remainingBytes = Math.max(0, usage.maxTotalBytes - usage.totalBytes);

  async function send(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    setError(undefined);

    try {
      const response = await uploadFiles(files);
      setOutcomes(response.outcomes);
      refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'The files could not be uploaded.');
    } finally {
      setUploading(false);

      // Cleared so selecting the same file again still fires a change event.
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  }

  return (
    <Card role="region" aria-labelledby="upload-title">
      <CardHeader>
        <CardTitle id="upload-title">Upload requirement files</CardTitle>
        <CardDescription>
          {SUPPORTED_EXTENSIONS.map((extension) => extension.toUpperCase()).join(', ')}. Scanned
          pages and images are read by text recognition, which needs checking afterwards.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div
          // Not a button: it is a drop target, and the keyboard route is the
          // real file input below rather than a click handler pretending to be
          // one.
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void send([...event.dataTransfer.files]);
          }}
          className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center ${
            dragging ? 'border-accent bg-accent-soft' : 'border-border'
          }`}
        >
          <p className="text-sm font-medium">Drag files here</p>
          <p className="text-xs text-muted">or</p>

          <label className="inline-flex cursor-pointer items-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2">
            Choose files
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={FILE_PICKER_ACCEPT}
              disabled={uploading || atFileLimit}
              className="sr-only"
              onChange={(event) => void send([...(event.target.files ?? [])])}
            />
          </label>

          <p className="text-xs text-muted">
            {usage.fileCount} of {usage.maxFiles} files · {formatBytes(remainingBytes)} of storage
            left
          </p>
        </div>

        <span role="status" aria-live="polite" className="text-sm">
          {uploading ? 'Uploading and checking your files…' : null}
        </span>

        {atFileLimit ? (
          <p role="alert" className="text-sm text-danger">
            This project has reached its limit of {usage.maxFiles} files. Delete a source to add
            another.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {outcomes.length > 0 ? (
          <ul aria-label="Upload results" className="flex flex-col gap-2">
            {outcomes.map((outcome) => (
              <li
                key={`${outcome.originalFilename}-${outcome.accepted ? 'ok' : outcome.errorCode}`}
                className={`rounded-md border p-3 text-sm ${
                  outcome.accepted
                    ? 'border-success/40 bg-success-soft'
                    : 'border-danger/40 bg-danger-soft'
                }`}
              >
                <span className="font-medium break-all">{outcome.originalFilename}</span>
                <span className="ml-2 text-xs">
                  {outcome.accepted ? 'Accepted — reading it now' : outcome.errorMessage}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
