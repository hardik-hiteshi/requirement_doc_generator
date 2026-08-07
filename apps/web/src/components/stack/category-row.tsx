'use client';

import {
  CATEGORY_APPLICABILITY_LABELS,
  COST_POSTURE_DESCRIPTIONS,
  COST_POSTURE_LABELS,
  SELECTION_SOURCES,
  SELECTION_SOURCE_DESCRIPTIONS,
  SELECTION_SOURCE_LABELS,
  STACK_COMPONENT_STATUS_LABELS,
  STACK_EVIDENCE_KIND_DESCRIPTIONS,
  STACK_EVIDENCE_KIND_LABELS,
  TECHNOLOGY_CATEGORY_LABELS,
  VERSION_SOURCE_LABELS,
  fillsCategory,
  isDecided,
  type CategoryApplicabilityEntry,
  type SelectionSource,
  type StackComponent,
  type StackSnapshot,
} from '@wdrg/contracts';
import { Badge, Button } from '@wdrg/ui';
import { useState } from 'react';

import {
  useDecideRecommendation,
  useLockComponent,
  useSelectTechnology,
  useTechnologyCatalog,
} from '@/hooks/use-stack';

/**
 * One technology category: what is in it, who put it there, and what to do.
 *
 * The row is where the precedence rule becomes visible. A suggestion says
 * "Suggested" and offers three buttons, none of which is pre-selected. A choice
 * the user made says "Chosen by you" and offers no accept/reject at all, because
 * there is nothing to accept — it is already theirs.
 *
 * Model prose is shown, labelled, behind a disclosure. What is *not* shown
 * anywhere is raw model output: no JSON, no scores presented as facts, and the
 * self-assessment always carries the sentence that says what it is worth.
 */
export function CategoryRow({
  entry,
  stack,
  components,
}: {
  readonly entry: CategoryApplicabilityEntry;
  readonly stack: StackSnapshot;
  readonly components: readonly StackComponent[];
}) {
  const [choosing, setChoosing] = useState(false);
  const locked = stack.status === 'LOCKED';

  return (
    <div className="rounded-md border border-border p-3" data-testid={`category-${entry.category}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{TECHNOLOGY_CATEGORY_LABELS[entry.category]}</h3>
          <p className="text-xs text-muted">{entry.reason}</p>
        </div>
        <Badge tone={entry.applicability === 'required' ? 'warning' : 'neutral'}>
          {CATEGORY_APPLICABILITY_LABELS[entry.applicability]}
        </Badge>
      </div>

      {components.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing chosen yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {components.map((component) => (
            <li key={component.id}>
              <ComponentCard component={component} stack={stack} />
            </li>
          ))}
        </ul>
      )}

      {!locked ? (
        <div className="mt-3">
          {choosing ? (
            <ChooseTechnology entry={entry} stack={stack} onDone={() => setChoosing(false)} />
          ) : (
            <Button variant="secondary" onClick={() => setChoosing(true)}>
              {components.length === 0
                ? `Choose a ${TECHNOLOGY_CATEGORY_LABELS[entry.category].toLowerCase()}`
                : 'Choose something else'}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ComponentCard({
  component,
  stack,
}: {
  readonly component: StackComponent;
  readonly stack: StackSnapshot;
}) {
  const decide = useDecideRecommendation();
  const lock = useLockComponent();
  const [replacing, setReplacing] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const isSuggestion = component.status === 'AI_RECOMMENDED';

  return (
    <div className="flex flex-col gap-2 rounded-md bg-subtle p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{component.technologyName}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isSuggestion ? 'neutral' : 'success'}>
            {STACK_COMPONENT_STATUS_LABELS[component.status]}
          </Badge>
          {component.mandatory ? <Badge tone="warning">Required by requirements</Badge> : null}
        </div>
      </div>

      {/*
        The commercial facts, from the reviewed catalogue rather than from the
        model. A custom technology says so instead of showing blanks that would
        read like facts.
      */}
      {component.technologyId ? (
        <dl className="grid gap-2 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted">Licence</dt>
            <dd>{component.licence || 'Not stated'}</dd>
          </div>
          <div>
            <dt className="text-muted">Cost</dt>
            <dd title={COST_POSTURE_DESCRIPTIONS[component.costPosture]}>
              {COST_POSTURE_LABELS[component.costPosture]}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Self-hosted</dt>
            <dd>{component.selfHostable ? 'Can be' : 'Cannot be'}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-xs text-muted">
          Your own choice. This application holds no reviewed licence or cost information about it,
          so none is shown.
        </p>
      )}

      {component.version.source !== 'UNSPECIFIED' ? (
        <p className="text-xs">
          Version {component.version.value}{' '}
          <span className="text-muted">({VERSION_SOURCE_LABELS[component.version.source]})</span>
        </p>
      ) : (
        <p className="text-xs text-muted">No version pinned.</p>
      )}

      <p className="text-xs">
        <span className="text-muted">{STACK_EVIDENCE_KIND_LABELS[component.evidence.kind]}:</span>{' '}
        {component.evidence.summary}
      </p>

      {component.evidence.requirementIds.length > 0 ? (
        <p className="text-xs text-muted">From {component.evidence.requirementIds.join(', ')}</p>
      ) : null}

      {component.recommendation ? (
        <div>
          <Button variant="secondary" onClick={() => setShowWhy((open) => !open)}>
            {showWhy ? 'Hide the reasoning' : 'Why this one?'}
          </Button>

          {showWhy ? (
            <div className="mt-2 flex flex-col gap-2 text-xs">
              <p>{component.recommendation.rationale}</p>

              {component.recommendation.benefits.length > 0 ? (
                <ListBlock
                  title="Good for this project"
                  items={component.recommendation.benefits}
                />
              ) : null}
              {component.recommendation.limitations.length > 0 ? (
                <ListBlock title="Limitations" items={component.recommendation.limitations} />
              ) : null}
              {component.recommendation.risks.length > 0 ? (
                <ListBlock title="Risks" items={component.recommendation.risks} />
              ) : null}
              {component.recommendation.operationalConsiderations.length > 0 ? (
                <ListBlock
                  title="What running it involves"
                  items={component.recommendation.operationalConsiderations}
                />
              ) : null}
              {component.recommendation.alternativeReason ? (
                <p>
                  <span className="font-medium">Another option:</span>{' '}
                  {component.recommendation.alternativeTechnologyId} —{' '}
                  {component.recommendation.alternativeReason}
                </p>
              ) : null}

              {/*
                The Phase 4 rule, carried forward verbatim in spirit: the
                model's self-assessment is shown, labelled, with the sentence
                that says what it is worth. It decides nothing.
              */}
              <p className="text-muted">
                AI self-assessment {Math.round(component.recommendation.modelConfidence * 100)}%.
                This is the model rating its own answer. It is not a probability and nothing in this
                application uses it to decide anything.
              </p>
              <p className="text-muted">
                {STACK_EVIDENCE_KIND_DESCRIPTIONS[component.evidence.kind]}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {component.replacedTechnologyName ? (
        <p className="text-xs text-muted">
          Replaced {component.replacedTechnologyName}
          {component.replacedReason ? `: ${component.replacedReason}` : '.'}
        </p>
      ) : null}

      {component.riskAcknowledgements.length > 0 ? (
        <p className="text-xs text-muted">
          You acknowledged {component.riskAcknowledgements.length} warning
          {component.riskAcknowledgements.length === 1 ? '' : 's'} and kept this.
        </p>
      ) : null}

      {stack.status !== 'LOCKED' ? (
        <div className="flex flex-wrap gap-2">
          {isSuggestion ? (
            <>
              <Button
                onClick={() =>
                  decide.mutate({
                    componentId: component.id,
                    request: { decision: 'accept', expectedVersion: stack.recordVersion },
                  })
                }
                disabled={decide.isPending}
              >
                Accept
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  decide.mutate({
                    componentId: component.id,
                    request: { decision: 'reject', expectedVersion: stack.recordVersion },
                  })
                }
                disabled={decide.isPending}
              >
                Reject
              </Button>
              <Button variant="secondary" onClick={() => setReplacing((open) => !open)}>
                Use something else
              </Button>
            </>
          ) : isDecided(component.status) ? (
            <Button
              variant="secondary"
              onClick={() =>
                lock.mutate({
                  componentId: component.id,
                  expectedVersion: stack.recordVersion,
                  locked: component.status !== 'LOCKED',
                })
              }
              disabled={lock.isPending || component.status === 'USER_SELECTED'}
            >
              {component.status === 'LOCKED' ? 'Unlock' : 'Lock this one'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {replacing ? (
        <ReplaceForm component={component} stack={stack} onDone={() => setReplacing(false)} />
      ) : null}

      {decide.isError ? (
        <p role="alert" className="text-xs text-danger">
          {decide.error.message}
        </p>
      ) : null}
      {lock.isError ? (
        <p role="alert" className="text-xs text-danger">
          {lock.error.message}
        </p>
      ) : null}
    </div>
  );
}

function ListBlock({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="list-inside list-disc">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Choosing a technology by hand.
 *
 * The catalogue is offered, and a free-text box sits beside it with equal
 * weight. A user whose client mandated something this application has never
 * heard of is not in an error state — they type it, and it is recorded exactly
 * as typed and treated as authoritative.
 */
function ChooseTechnology({
  entry,
  stack,
  onDone,
}: {
  readonly entry: CategoryApplicabilityEntry;
  readonly stack: StackSnapshot;
  readonly onDone: () => void;
}) {
  const { data: catalog } = useTechnologyCatalog();
  const select = useSelectTechnology();
  const [technologyId, setTechnologyId] = useState('');
  const [customName, setCustomName] = useState('');
  const [source, setSource] = useState<SelectionSource>('USER');
  const [notes, setNotes] = useState('');

  const options = (catalog?.entries ?? []).filter((candidate) =>
    fillsCategory(candidate, entry.category),
  );

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();

        if (!technologyId && !customName.trim()) {
          return;
        }

        select.mutate(
          {
            category: entry.category,
            ...(technologyId ? { technologyId } : { customName: customName.trim() }),
            selectionSource: source,
            // A client mandate is a different fact from a team preference, and
            // the later documents need to tell them apart.
            mandatory: source === 'CLIENT_REQUIREMENT',
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            expectedVersion: stack.recordVersion,
          },
          { onSuccess: onDone },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">From the catalogue</span>
        <select
          value={technologyId}
          onChange={(event) => {
            setTechnologyId(event.target.value);
            setCustomName('');
          }}
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          <option value="">Choose one…</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Or type your own</span>
        <input
          value={customName}
          onChange={(event) => {
            setCustomName(event.target.value);
            setTechnologyId('');
          }}
          placeholder="Anything, including something not listed above"
          className="rounded-md border border-border px-2 py-1 text-sm"
        />
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium">Where does this come from?</legend>
        {SELECTION_SOURCES.map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`source-${entry.category}`}
              checked={source === value}
              onChange={() => setSource(value)}
              className="mt-1"
            />
            <span>
              <span>{SELECTION_SOURCE_LABELS[value]}</span>
              <span className="block text-xs text-muted">
                {SELECTION_SOURCE_DESCRIPTIONS[value]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Notes</span>
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="rounded-md border border-border px-2 py-1 text-sm"
        />
      </label>

      <div className="flex gap-2">
        <Button type="submit" disabled={select.isPending || (!technologyId && !customName.trim())}>
          Use this
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {select.isError ? (
        <p role="alert" className="text-xs text-danger">
          {select.error.message}
        </p>
      ) : null}
    </form>
  );
}

function ReplaceForm({
  component,
  stack,
  onDone,
}: {
  readonly component: StackComponent;
  readonly stack: StackSnapshot;
  readonly onDone: () => void;
}) {
  const { data: catalog } = useTechnologyCatalog();
  const decide = useDecideRecommendation();
  const [technologyId, setTechnologyId] = useState('');
  const [customName, setCustomName] = useState('');
  const [reason, setReason] = useState('');

  const options = (catalog?.entries ?? []).filter((candidate) =>
    fillsCategory(candidate, component.category),
  );

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();

        decide.mutate(
          {
            componentId: component.id,
            request: {
              decision: 'replace',
              ...(technologyId ? { technologyId } : { customName: customName.trim() }),
              ...(reason.trim() ? { reason: reason.trim() } : {}),
              expectedVersion: stack.recordVersion,
            },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Use instead</span>
        <select
          value={technologyId}
          onChange={(event) => {
            setTechnologyId(event.target.value);
            setCustomName('');
          }}
          className="rounded-md border border-border px-2 py-1 text-sm"
        >
          <option value="">Choose one…</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Or type your own</span>
        <input
          value={customName}
          onChange={(event) => {
            setCustomName(event.target.value);
            setTechnologyId('');
          }}
          className="rounded-md border border-border px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Why?</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="rounded-md border border-border px-2 py-1 text-sm"
        />
      </label>

      <div className="flex gap-2">
        <Button type="submit" disabled={decide.isPending || (!technologyId && !customName.trim())}>
          Replace it
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
