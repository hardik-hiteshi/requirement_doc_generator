'use client';

import {
  describeReference,
  detectInjectionSignals,
  EVIDENCE_NOTICE,
  isLowConfidence,
  type ExtractedBlock,
  type RequirementSource,
} from '@wdrg/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Textarea,
} from '@wdrg/ui';
import { useEffect, useMemo, useState } from 'react';

import { ApiClientError } from '@/lib/api-client';
import { correctContent, markReviewed, restoreOriginal } from '@/lib/requirements-api';
import { useSourceMutation } from '@/hooks/use-sources';

export interface ReviewPanelProps {
  readonly source: RequirementSource;
}

/**
 * Reviewing and correcting what was read from a source.
 *
 * The design follows from one fact: **extraction is not always right, and the
 * user is the only one who can tell.** So the panel makes the uncertain parts
 * findable rather than burying them in a wall of text — a filter for
 * low-confidence blocks, the original visible beside a correction, and a
 * citation on every block so a reader can check it against the real document.
 *
 * Corrections are staged locally and saved together. Saving per keystroke would
 * produce a revision per character; saving per block would produce a revision
 * per block. A revision should mean "a person finished a pass over this".
 */
export function ReviewPanel({ source }: ReviewPanelProps) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [onlyUncertain, setOnlyUncertain] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Staged edits belong to the source that was open. Keeping them across a
  // switch would apply one source's corrections to another's block ids.
  //
  // Deferred to a microtask: setting state synchronously in an effect body
  // triggers a cascading render.
  useEffect(() => {
    queueMicrotask(() => {
      setEdits({});
      setError(undefined);
    });
  }, [source.sourceId, source.currentRevision]);

  const save = useSourceMutation(
    (corrections: { blockId: string; text: string }[]) =>
      correctContent(source.sourceId, { version: source.version, corrections }),
    { sourceId: source.sourceId },
  );

  const restore = useSourceMutation(() => restoreOriginal(source.sourceId, source.version), {
    sourceId: source.sourceId,
  });

  const review = useSourceMutation(() => markReviewed(source.sourceId, source.version), {
    sourceId: source.sourceId,
  });

  const content = source.effectiveContent;
  const original = source.originalContent;

  const injectionSignals = useMemo(
    () => detectInjectionSignals(content?.blocks.map((block) => block.text).join('\n') ?? ''),
    [content],
  );

  if (!content) {
    return (
      <Card role="region" aria-labelledby="review-title">
        <CardHeader>
          <CardTitle id="review-title">Extraction review</CardTitle>
          <CardDescription>
            {source.status === 'FAILED'
              ? (source.failureMessage ?? 'This source could not be read.')
              : 'This source has not been read yet.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const visible = onlyUncertain ? content.blocks.filter(isLowConfidence) : content.blocks;
  const uncertainCount = content.blocks.filter(isLowConfidence).length;
  const pending = Object.entries(edits).filter(([blockId, text]) => {
    const block = content.blocks.find((candidate) => candidate.id === blockId);
    return block !== undefined && block.text !== text;
  });

  return (
    <Card role="region" aria-labelledby="review-title">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle id="review-title">Extraction review</CardTitle>
            <CardDescription>
              {source.title} · {content.blocks.length} block
              {content.blocks.length === 1 ? '' : 's'} · read by {content.extractor}
              {source.currentRevision > 0 ? ` · revision ${source.currentRevision}` : ''}
            </CardDescription>
          </div>

          {source.reviewStatus === 'REVIEWED' ? (
            <Badge tone="success">Reviewed</Badge>
          ) : (
            <Badge tone="warning">Not reviewed</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {content.warnings.length > 0 ? (
          <ul aria-label="Extraction warnings" className="flex flex-col gap-2">
            {content.warnings.map((warning) => (
              <li
                key={warning.code}
                className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm"
              >
                {warning.message}
                {warning.reference ? (
                  <span className="ml-2 text-xs text-muted">
                    {describeReference(warning.reference)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {injectionSignals.length > 0 ? (
          <p className="rounded-md border border-border bg-surface-hover p-3 text-sm">
            {EVIDENCE_NOTICE}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyUncertain}
              disabled={uncertainCount === 0}
              onChange={(event) => setOnlyUncertain(event.currentTarget.checked)}
              className="size-4 rounded border-border"
            />
            Show only uncertain text ({uncertainCount})
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showOriginal}
              disabled={source.currentRevision === 0}
              onChange={(event) => setShowOriginal(event.currentTarget.checked)}
              className="size-4 rounded border-border"
            />
            Compare with the original
          </label>
        </div>

        <ul aria-label="Extracted content" className="flex flex-col gap-3">
          {visible.map((block) => (
            <BlockEditor
              key={block.id}
              block={block}
              original={showOriginal ? original?.blocks.find((b) => b.id === block.id) : undefined}
              value={edits[block.id] ?? block.text}
              onChange={(text) => setEdits((current) => ({ ...current, [block.id]: text }))}
            />
          ))}
        </ul>

        {visible.length === 0 ? (
          <p className="text-sm text-muted">Nothing is flagged as uncertain in this source.</p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending.length === 0 || save.isPending}
            onClick={() => {
              setError(undefined);
              save.mutate(
                pending.map(([blockId, text]) => ({ blockId, text })),
                {
                  onError: (caught: unknown) =>
                    setError(
                      caught instanceof ApiClientError
                        ? caught.message
                        : 'The corrections could not be saved.',
                    ),
                },
              );
            }}
          >
            {save.isPending
              ? 'Saving…'
              : `Save ${pending.length} correction${pending.length === 1 ? '' : 's'}`}
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={source.currentRevision === 0 || restore.isPending}
            onClick={() => {
              setError(undefined);
              restore.mutate(undefined, {
                onError: (caught: unknown) =>
                  setError(
                    caught instanceof ApiClientError
                      ? caught.message
                      : 'The original could not be restored.',
                  ),
              });
            }}
          >
            Restore the original
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={source.reviewStatus === 'REVIEWED' || review.isPending}
            onClick={() => {
              setError(undefined);
              review.mutate(undefined, {
                onError: (caught: unknown) =>
                  setError(
                    caught instanceof ApiClientError
                      ? caught.message
                      : 'The source could not be marked reviewed.',
                  ),
              });
            }}
          >
            {source.reviewStatus === 'REVIEWED' ? 'Reviewed' : 'Mark reviewed'}
          </Button>
        </div>

        {source.revisions.length > 1 ? (
          <details className="text-sm">
            <summary className="cursor-pointer">
              Revision history ({source.revisions.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
              {source.revisions.map((revision) => (
                <li key={revision.revision}>
                  Revision {revision.revision} · {revision.origin.toLowerCase()} ·{' '}
                  {new Date(revision.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
                  {revision.changedBlockIds.length > 0
                    ? ` · ${revision.changedBlockIds.length} block(s) changed`
                    : ''}
                  {revision.note ? ` · ${revision.note}` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface BlockEditorProps {
  readonly block: ExtractedBlock;
  readonly original: ExtractedBlock | undefined;
  readonly value: string;
  readonly onChange: (text: string) => void;
}

/**
 * One block, with its citation and its confidence.
 *
 * The citation is what makes review possible at all: "Page 4" or "Features!B2"
 * lets a reader open the real document and check. A block with no citation says
 * so rather than showing a made-up one.
 */
function BlockEditor({ block, original, value, onChange }: BlockEditorProps) {
  const citation = describeReference(block.reference);
  const uncertain = isLowConfidence(block);
  const changed = original !== undefined && original.text !== value;

  return (
    <li
      className={`rounded-md border p-3 ${uncertain ? 'border-warning/60 bg-warning-soft' : 'border-border'}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="font-mono">{block.kind.replace('_', ' ')}</span>

        {citation ? (
          <span className="font-medium text-foreground">{citation}</span>
        ) : (
          <span>No page or row reference for this content</span>
        )}

        {block.viaOcr ? (
          <Badge tone={uncertain ? 'warning' : 'neutral'}>
            Recognised · {Math.round(block.confidence * 100)}% confident
          </Badge>
        ) : null}
      </div>

      <label className="sr-only" htmlFor={`block-${block.id}`}>
        {citation ? `Extracted text from ${citation}` : 'Extracted text'}
      </label>
      <Textarea
        id={`block-${block.id}`}
        rows={Math.min(8, Math.max(2, Math.ceil(value.length / 90)))}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />

      {original ? (
        <div className="mt-2 rounded-md border border-border bg-surface-hover p-2 text-xs">
          <span className="font-medium">Original: </span>
          <span className={changed ? 'line-through' : ''}>{original.text}</span>
        </div>
      ) : null}
    </li>
  );
}
