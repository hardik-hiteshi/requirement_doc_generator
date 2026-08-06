'use client';

import {
  isRetryable,
  isRetryableError,
  isSourceInProgress,
  SOURCE_STATUS_LABELS,
  type RequirementSourceSummary,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { deleteSource, downloadUrl, retrySource } from '@/lib/requirements-api';
import { useSourceMutation } from '@/hooks/use-sources';
import { formatBytes } from './upload-panel';

export interface SourceListProps {
  readonly sources: readonly RequirementSourceSummary[];
  readonly selectedId: string | undefined;
  readonly onSelect: (sourceId: string) => void;
}

/**
 * Whether offering a retry would be honest.
 *
 * The server enforces the same rule and refuses a pointless retry, so this is
 * about not inviting the click in the first place.
 */
function canRetry(source: RequirementSourceSummary): boolean {
  if (!isRetryable(source.status)) {
    return false;
  }

  return source.failureCode === undefined || isRetryableError(source.failureCode);
}

/** Colour is never the only signal: every state is also spelled out in words. */
function toneFor(
  source: RequirementSourceSummary,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (source.status === 'FAILED') {
    return 'danger';
  }

  if (source.status === 'REVIEW_REQUIRED') {
    return 'warning';
  }

  if (source.status === 'READY') {
    return source.reviewStatus === 'REVIEWED' ? 'success' : 'info';
  }

  return 'neutral';
}

export function SourceList({ sources, selectedId, onSelect }: SourceListProps) {
  const retry = useSourceMutation(retrySource);
  const remove = useSourceMutation(deleteSource);

  if (sources.length === 0) {
    return (
      <Card role="region" aria-labelledby="sources-title">
        <CardHeader>
          <CardTitle id="sources-title">Requirement sources</CardTitle>
          <CardDescription>
            Nothing yet. Paste some text or upload a file to get started.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card role="region" aria-labelledby="sources-title">
      <CardHeader>
        <CardTitle id="sources-title">Requirement sources</CardTitle>
        <CardDescription>
          {sources.length} source{sources.length === 1 ? '' : 's'}. Select one to review what was
          read from it.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ul className="flex flex-col gap-2">
          {sources.map((source) => {
            const selected = source.sourceId === selectedId;

            return (
              <li
                key={source.sourceId}
                className={`rounded-md border p-3 ${
                  selected ? 'border-accent bg-accent-soft' : 'border-border'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <button
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelect(source.sourceId)}
                      className="text-left text-sm font-medium break-all underline-offset-2 hover:underline"
                    >
                      {source.title}
                    </button>

                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Badge tone={toneFor(source)}>{SOURCE_STATUS_LABELS[source.status]}</Badge>

                      {source.reviewStatus === 'REVIEWED' ? (
                        <Badge tone="success">Reviewed</Badge>
                      ) : null}

                      {source.kind === 'FILE' && source.file ? (
                        <span>
                          {source.file.extension.toUpperCase()} ·{' '}
                          {formatBytes(source.file.sizeBytes)}
                        </span>
                      ) : (
                        <span>
                          Pasted text · {(source.textLength ?? 0).toLocaleString()} characters
                        </span>
                      )}

                      {source.lowConfidenceBlockCount ? (
                        <span className="text-warning">
                          {source.lowConfidenceBlockCount} uncertain
                        </span>
                      ) : null}

                      {source.warningCount ? <span>{source.warningCount} warning(s)</span> : null}
                    </span>

                    {source.failureMessage ? (
                      <span role="alert" className="text-xs text-danger">
                        {source.failureMessage}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    {/*
                      Shown only where a retry could actually help: the source
                      has failed *and* the failure is one a retry could clear. A
                      damaged file or a wrong format will fail again every time,
                      and a button that always fails is worse than no button.
                    */}
                    {canRetry(source) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(source.sourceId)}
                      >
                        Retry
                      </Button>
                    ) : null}

                    {source.kind === 'FILE' ? (
                      <Button variant="secondary" size="sm" asChild>
                        <a href={downloadUrl(source.sourceId)} download>
                          Download
                        </a>
                      </Button>
                    ) : null}

                    <Button
                      variant="danger"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(source.sourceId)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>

                {isSourceInProgress(source.status) ? (
                  <p role="status" className="mt-2 text-xs text-muted">
                    {SOURCE_STATUS_LABELS[source.status]}…
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
