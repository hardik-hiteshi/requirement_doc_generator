'use client';

import {
  REVISION_DECISION_LABELS,
  REVISION_DECISIONS,
  type DocumentSection,
  type DocumentType,
} from '@wdrg/contracts';
import { Badge, Button } from '@wdrg/ui';
import { useState } from 'react';

import {
  isVersionConflict,
  useRegenerateSection,
  useResolveProposal,
  useUpdateSection,
  VERSION_CONFLICT_MESSAGE,
} from '@/hooks/use-documents';

/**
 * One section, with everything a reviewer does to it.
 *
 * ## The proposal is the interesting part
 *
 * When a section a person wrote is regenerated, the new text arrives *beside* it
 * rather than over it, and the three options are laid out as three buttons. That
 * is the whole edit-authority rule made visible: nothing here can quietly replace
 * a sentence somebody decided on.
 *
 * An empty section shows its reason rather than nothing. "The approved
 * requirements say nothing about this" is information; a blank panel is a bug
 * report waiting to be filed.
 */
export function SectionEditor({
  type,
  section,
  recordVersion,
  editable,
  aiAvailable,
}: {
  readonly type: DocumentType;
  readonly section: DocumentSection;
  readonly recordVersion: number;
  readonly editable: boolean;
  readonly aiAvailable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.body);
  const [instruction, setInstruction] = useState('');
  const [revising, setRevising] = useState(false);
  const [revision, setRevision] = useState('');

  const update = useUpdateSection(type);
  const regenerate = useRegenerateSection(type);
  const resolve = useResolveProposal(type);

  const proposal = section.proposedBody;

  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      data-testid={`section-${section.key}`}
      aria-label={section.title}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{section.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {section.origin === 'GENERATED' ? null : (
            <Badge tone="neutral" data-testid={`section-origin-${section.key}`}>
              Yours
            </Badge>
          )}
          {proposal ? (
            <Badge tone="warning" data-testid={`section-proposal-${section.key}`}>
              Suggested rewrite
            </Badge>
          ) : null}
        </div>
      </div>

      {section.body.trim().length === 0 && section.omittedReason ? (
        <p className="text-sm text-muted" data-testid={`section-omitted-${section.key}`}>
          {section.omittedReason}
        </p>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{section.title}</span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              className="rounded-md border border-border p-2 text-sm"
              data-testid={`section-input-${section.key}`}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                update.mutate(
                  { sectionId: section.sectionId, body: draft, expectedVersion: recordVersion },
                  { onSuccess: () => setEditing(false) },
                );
              }}
              disabled={update.isPending}
              data-testid={`section-save-${section.key}`}
            >
              Save this section
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {/*
           * A lost race is told apart from every other failure. The user's text is
           * still in the box and still good; what they need is to see what changed,
           * not a retry that would overwrite somebody else's work.
           */}
          {update.isError ? (
            <p
              role="alert"
              className="text-xs text-danger"
              data-testid={isVersionConflict(update.error) ? 'section-conflict' : 'section-error'}
            >
              {isVersionConflict(update.error) ? VERSION_CONFLICT_MESSAGE : update.error.message}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm" data-testid={`section-body-${section.key}`}>
          {section.body}
        </p>
      )}

      {proposal ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-warning p-3"
          data-testid={`proposal-${section.key}`}
        >
          <p className="text-xs font-medium">
            A rewrite was suggested. What you wrote is still above — this is the alternative.
          </p>
          <p className="whitespace-pre-wrap text-sm text-muted">{proposal}</p>

          {revising ? (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Your version, starting from the suggestion</span>
              <textarea
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                rows={6}
                className="rounded-md border border-border p-2 text-sm"
                data-testid={`proposal-input-${section.key}`}
              />
            </label>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {REVISION_DECISIONS.map((decision) => (
              <Button
                key={decision}
                variant={decision === 'KEEP_CURRENT' ? 'primary' : 'secondary'}
                disabled={resolve.isPending}
                data-testid={`proposal-${decision}-${section.key}`}
                onClick={() => {
                  if (decision === 'EDIT_GENERATED_REVISION' && !revising) {
                    setRevision(proposal);
                    setRevising(true);
                    return;
                  }

                  resolve.mutate(
                    {
                      sectionId: section.sectionId,
                      decision: decision,
                      ...(decision === 'EDIT_GENERATED_REVISION' ? { body: revision } : {}),
                      expectedVersion: recordVersion,
                    },
                    { onSuccess: () => setRevising(false) },
                  );
                }}
              >
                {REVISION_DECISION_LABELS[decision]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {section.references.length > 0 ? (
        <details data-testid={`section-sources-${section.key}`}>
          <summary className="cursor-pointer text-xs text-muted">
            Where this comes from ({section.references.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {section.references.slice(0, 40).map((reference) => (
              <li key={reference.id} data-testid={`reference-${reference.id}`}>
                <span className="font-medium">{reference.id}</span>
                {reference.label ? ` — ${reference.label}` : null}
                {reference.pageNumber ? ` (page ${reference.pageNumber})` : null}
                {reference.lineNumber ? ` (line ${reference.lineNumber})` : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editable && !editing ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(section.body);
                setEditing(true);
              }}
              data-testid={`section-edit-${section.key}`}
            >
              Edit this section
            </Button>
            <Button
              variant="secondary"
              disabled={regenerate.isPending}
              data-testid={`section-regenerate-${section.key}`}
              onClick={() =>
                regenerate.mutate({
                  sectionId: section.sectionId,
                  useAi: aiAvailable,
                  ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
                  expectedVersion: recordVersion,
                })
              }
            >
              Rewrite this section
            </Button>
          </div>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted">
              Anything you want different? This is treated as a request about wording — it cannot
              add scope.
            </span>
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              className="rounded-md border border-border px-2 py-1 text-sm"
              data-testid={`section-instruction-${section.key}`}
            />
          </label>
          {regenerate.isError ? (
            <p role="alert" className="text-xs text-danger">
              {regenerate.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
