'use client';

import {
  compareForReview,
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_CATEGORY_LABELS,
  REQUIREMENT_PRIORITIES,
  type RequirementCategory,
  type RequirementItem,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useEditRequirement } from '@/hooks/use-analysis';
import { EvidenceConfidenceBadge, ModelConfidenceNote } from './confidence';

/**
 * The requirements, worst evidence first.
 *
 * The ordering is the design. A reviewer's attention is the scarce resource, and
 * a list in document order spends it on the requirements that are already fine.
 * `compareForReview` sorts by **evidence-derived** confidence — not the model's
 * self-assessment — so the items most likely to be wrong are the ones seen
 * first.
 *
 * Every requirement shows the words it came from. A baseline whose rows cannot
 * be checked against the source is a document the client has to take on trust,
 * which is the opposite of what this application is for.
 */
export function RequirementList({ items }: { readonly items: readonly RequirementItem[] }) {
  const [filter, setFilter] = useState<RequirementCategory | 'all'>('all');
  const visible = items
    .filter((item) => item.status !== 'superseded' && item.status !== 'rejected')
    .filter((item) => filter === 'all' || item.category === filter)
    .toSorted(compareForReview);

  const present = REQUIREMENT_CATEGORIES.filter((category) =>
    items.some((item) => item.category === category),
  );

  return (
    <Card role="region" aria-labelledby="requirements-title">
      <CardHeader>
        <CardTitle id="requirements-title">Requirements</CardTitle>
        <CardDescription>
          Ordered by how well each one is evidenced, weakest first — those are the ones worth your
          time. Every requirement links back to the text it came from.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
            All ({items.length})
          </FilterButton>
          {present.map((category) => (
            <FilterButton
              key={category}
              active={filter === category}
              onClick={() => setFilter(category)}
            >
              {REQUIREMENT_CATEGORY_LABELS[category]} (
              {items.filter((item) => item.category === category).length})
            </FilterButton>
          ))}
        </div>

        {visible.length === 0 ? (
          <p className="text-sm text-muted">No requirements in this category.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((item) => (
              <RequirementRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
        active ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted'
      }`}
    >
      {children}
    </button>
  );
}

function RequirementRow({ item }: { readonly item: RequirementItem }) {
  const [editing, setEditing] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const edit = useEditRequirement();

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted">{item.key}</span>
            <Badge tone="neutral">{REQUIREMENT_CATEGORY_LABELS[item.category]}</Badge>
            {item.priority !== 'unspecified' ? <Badge tone="info">{item.priority}</Badge> : null}
            {item.origin === 'manual' ? <Badge tone="info">Added by you</Badge> : null}
            {item.origin === 'clarification' ? (
              <Badge tone="warning">Recorded assumption</Badge>
            ) : null}
            {item.needsRevalidation ? <Badge tone="warning">Check this again</Badge> : null}
            {item.proposedRevision ? <Badge tone="info">Change proposed</Badge> : null}
            {item.status === 'accepted' ? <Badge tone="success">Accepted</Badge> : null}
            {item.editedByUser && item.origin === 'ai' ? (
              <Badge tone="info">Edited by you</Badge>
            ) : null}
          </div>
          <h3 className="font-medium">{item.title}</h3>
        </div>

        <EvidenceConfidenceBadge confidence={item.evidenceConfidence} />
      </div>

      <p className="mt-2 text-sm">{item.statement}</p>
      <ModelConfidenceNote confidence={item.modelConfidence} />

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => setShowEvidence((current) => !current)}
          aria-expanded={showEvidence}
        >
          {showEvidence ? 'Hide source' : `Source (${item.references.length})`}
        </Button>
        {item.status !== 'accepted' ? (
          <Button
            variant="secondary"
            disabled={edit.isPending}
            onClick={() =>
              edit.mutate({ itemId: item.id, status: 'accepted', expectedVersion: item.version })
            }
          >
            Accept
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setEditing((current) => !current)}>
          {editing ? 'Cancel' : 'Edit'}
        </Button>
        <Button
          variant="secondary"
          disabled={edit.isPending}
          onClick={() =>
            edit.mutate({ itemId: item.id, status: 'rejected', expectedVersion: item.version })
          }
        >
          Reject
        </Button>
      </div>

      {showEvidence ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3 text-xs">
          {item.references.length === 0 ? (
            <p className="text-danger">
              This requirement has no link to any document, so there is nothing to check it against.
              It blocks approval until you link it or reject it.
            </p>
          ) : (
            item.references.map((reference, index) => (
              <div key={`${reference.blockId}-${index}`} className="flex flex-col gap-1">
                <p className="text-muted">
                  {reference.kind === 'clarification' ? (
                    /* Evidence in its own right: somebody asked the client and
                       wrote down what they said. */
                    <span className="text-success">
                      Confirmed clarification {reference.label ?? ''}
                    </span>
                  ) : reference.verified ? (
                    <span className="text-success">Found in the document</span>
                  ) : (
                    /*
                      Stated plainly, because this is the single most useful
                      thing the screen can tell a reviewer: the model quoted
                      something the document does not say.
                    */
                    <span className="text-danger">
                      Not found in the document it cites — check this one
                    </span>
                  )}
                  {reference.reference.pageNumber
                    ? ` · Page ${reference.reference.pageNumber}`
                    : ''}
                  {reference.reference.sheetName ? ` · ${reference.reference.sheetName}` : ''}
                  {reference.reference.rowNumber ? ` · Row ${reference.reference.rowNumber}` : ''}
                  {reference.reference.lineNumber
                    ? ` · Line ${reference.reference.lineNumber}`
                    : ''}
                </p>
                <blockquote className="border-l-2 border-border pl-2 italic">
                  {reference.excerpt}
                </blockquote>
              </div>
            ))
          )}
        </div>
      ) : null}

      {editing ? <EditForm item={item} onDone={() => setEditing(false)} /> : null}

      {edit.isError ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {edit.error.message}
        </p>
      ) : null}
    </li>
  );
}

function EditForm({
  item,
  onDone,
}: {
  readonly item: RequirementItem;
  readonly onDone: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [statement, setStatement] = useState(item.statement);
  const [category, setCategory] = useState(item.category);
  const [priority, setPriority] = useState(item.priority);
  const edit = useEditRequirement();

  return (
    <form
      className="mt-3 flex flex-col gap-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        edit.mutate(
          {
            itemId: item.id,
            title,
            statement,
            category,
            priority,
            expectedVersion: item.version,
          },
          { onSuccess: onDone },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="rounded-md border border-border px-2 py-1 text-sm"
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Requirement</span>
        <textarea
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          rows={3}
          className="rounded-md border border-border px-2 py-1 text-sm"
          required
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Category</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as RequirementCategory)}
            className="rounded-md border border-border px-2 py-1 text-sm"
          >
            {REQUIREMENT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {REQUIREMENT_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Priority</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as typeof priority)}
            className="rounded-md border border-border px-2 py-1 text-sm"
          >
            {REQUIREMENT_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value === 'unspecified' ? 'Not stated' : value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-muted">
        Your wording is kept. A later analysis may suggest a different one, but it will not replace
        this.
      </p>

      <div className="flex gap-2">
        <Button type="submit" disabled={edit.isPending}>
          {edit.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
