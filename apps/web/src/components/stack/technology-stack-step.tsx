'use client';

import {
  CATEGORY_APPLICABILITY_LABELS,
  RISK_LEVEL_LABELS,
  STACK_AI_NOTICE,
  STACK_SELECTION_MODES,
  STACK_SELECTION_MODE_DESCRIPTIONS,
  STACK_SELECTION_MODE_LABELS,
  STACK_SNAPSHOT_STATUS_LABELS,
  TECHNOLOGY_CATEGORY_LABELS,
  type CategoryApplicabilityEntry,
  type StackComponent,
  type StackSnapshot,
  type TechnologyCategory,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useApproveStack,
  useLockStack,
  useRecommendationRun,
  useRequestRecommendations,
  useStack,
  useSetSelectionMode,
  useUnlockStack,
} from '@/hooks/use-stack';
import { CategoryRow } from './category-row';
import { CompatibilityPanel } from './compatibility-panel';
import { StackHistory } from './stack-history';

/**
 * Choosing the technologies, and committing to them.
 *
 * The screen is arranged around one claim it has to make credible: **your
 * decisions are safe here**. So the mode choice comes first and says plainly
 * that anything already chosen is untouched; every row shows who decided it;
 * a suggestion is visibly a suggestion until somebody accepts it; and the two
 * commitments — approve, then lock — are separate buttons with separate
 * meanings, because one of them is what a later estimate is built on.
 */
export function TechnologyStackStep() {
  const { data, isPending, isError } = useStack();
  const { data: runView } = useRecommendationRun();
  const recommend = useRequestRecommendations();
  const approve = useApproveStack();
  const lock = useLockStack();
  const unlock = useUnlockStack();
  const [acknowledged, setAcknowledged] = useState(false);
  const [downstreamAcknowledged, setDownstreamAcknowledged] = useState(false);

  if (isPending) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted">Loading your technology stack…</p>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-danger">
            The technology stack could not be loaded. Reload the page to try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  const stack = data.snapshot;
  const isLocked = stack.status === 'LOCKED';
  const canApprove = stack.blockers.length === 0 && stack.components.length > 0;

  return (
    <section
      aria-label="Technology stack"
      role="region"
      className="flex flex-col gap-4"
      data-testid="technology-stack"
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Technology stack</CardTitle>
            <div className="flex items-center gap-2">
              <Badge tone={toneFor(stack.status)} data-testid="stack-status">
                {STACK_SNAPSHOT_STATUS_LABELS[stack.status]}
              </Badge>
              <span className="text-xs text-muted">Stack v{stack.version}</span>
            </div>
          </div>
          <CardDescription>{STACK_AI_NOTICE}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ProjectContext stack={stack} />

          {stack.status === 'OUTDATED' ? (
            <p role="status" className="rounded-md bg-warning-subtle p-3 text-sm">
              The requirements changed after this stack was set. Nothing has been altered — review
              it and approve again when you are satisfied.
            </p>
          ) : null}

          {isLocked ? (
            <LockedNotice
              onUnlock={(reason) => unlock.mutate({ reason, expectedVersion: stack.recordVersion })}
              pending={unlock.isPending}
              error={unlock.isError ? unlock.error.message : undefined}
            />
          ) : (
            <ModeChooser stack={stack} />
          )}
        </CardContent>
      </Card>

      {!isLocked && stack.selectionMode !== 'USER_SELECTS_ALL' ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Let the AI suggest the rest</h3>
                <p className="text-xs text-muted">
                  It only looks at categories you have not decided. Anything you chose stays exactly
                  as you set it.
                </p>
              </div>
              <Button
                onClick={() => recommend.mutate({ expectedVersion: stack.recordVersion })}
                disabled={recommend.isPending || runView?.configured === false}
              >
                {recommend.isPending ? 'Working…' : 'Suggest technologies'}
              </Button>
            </div>

            {/*
              The manual-mode promise, stated where it matters. A deployment
              with no inference server must not look broken here — it must look
              like a workflow that does not need one.
            */}
            {runView?.configured === false ? (
              <p role="status" className="text-xs text-muted">
                AI suggestions are not switched on for this deployment. Choose your technologies
                below — you can approve and lock the stack without them.
              </p>
            ) : null}

            {recommend.isError ? (
              <p role="alert" className="text-xs text-danger">
                {recommend.error.message}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <CompatibilityPanel stack={stack} />

      <Card>
        <CardHeader>
          <CardTitle>Your technologies</CardTitle>
          <CardDescription>
            Only the categories a project like yours has. Nothing is added because the project
            sounds large.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {applicableCategories(stack.categoryPlan).map((entry) => (
            <CategoryRow
              key={entry.category}
              entry={entry}
              stack={stack}
              components={componentsIn(stack, entry.category)}
            />
          ))}

          <ConditionalCategories stack={stack} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approve and lock</CardTitle>
          <CardDescription>
            Approving says these are the right technologies. Locking is what later phases build on.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {stack.blockers.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Before you can approve</h3>
              <ul className="flex flex-col gap-2">
                {stack.blockers.map((blocker) => (
                  <li key={blocker.kind} className="rounded-md border border-border p-3 text-sm">
                    <p className="font-medium">{blocker.summary}</p>
                    <p className="text-xs text-muted">{blocker.action}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {stack.status === 'APPROVED' || isLocked ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                Approved{stack.approvedAt ? ` on ${formatDate(stack.approvedAt)}` : ''}.
                {isLocked
                  ? ' Locked, and authoritative for estimation and every document that follows.'
                  : ''}
              </p>

              {!isLocked ? (
                <>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={downstreamAcknowledged}
                      onChange={(event) => setDownstreamAcknowledged(event.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      I understand that locking makes this stack authoritative — estimation and
                      every later document will use exactly these technologies.
                    </span>
                  </label>
                  <Button
                    className="self-start"
                    disabled={!downstreamAcknowledged || lock.isPending}
                    onClick={() =>
                      lock.mutate({
                        acknowledgedDownstreamAuthority: true,
                        expectedVersion: stack.recordVersion,
                      })
                    }
                  >
                    Lock this stack
                  </Button>
                </>
              ) : null}

              {lock.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {lock.error.message}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I have read these technologies and I am accountable for them, whether the AI
                  suggested them or I chose them.
                </span>
              </label>
              <Button
                className="self-start"
                disabled={!canApprove || !acknowledged || approve.isPending}
                onClick={() =>
                  approve.mutate({
                    acknowledgedAiAssistance: true,
                    expectedVersion: stack.recordVersion,
                  })
                }
              >
                Approve this stack
              </Button>
              {approve.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {approve.error.message}
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <StackHistory />
    </section>
  );
}

/** What the stack was decided against, so a reader can check it themselves. */
function ProjectContext({ stack }: { readonly stack: StackSnapshot }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-xs text-muted">Project type</dt>
        <dd>{stack.projectTypes.join(', ') || 'Not confirmed'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Built against</dt>
        <dd>{stack.baselineVersion ? `Baseline v${stack.baselineVersion}` : 'No baseline yet'}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">Highest concern</dt>
        <dd>{RISK_LEVEL_LABELS[stack.highestRisk]}</dd>
      </div>
    </dl>
  );
}

function ModeChooser({ stack }: { readonly stack: StackSnapshot }) {
  const setMode = useSetSelectionMode();

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">How would you like to fill this in?</legend>
      {STACK_SELECTION_MODES.map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="selection-mode"
            checked={stack.selectionMode === mode}
            onChange={() =>
              setMode.mutate({
                mode: mode,
                expectedVersion: stack.recordVersion,
              })
            }
            className="mt-1"
          />
          <span>
            <span className="font-medium">{STACK_SELECTION_MODE_LABELS[mode]}</span>
            <span className="block text-xs text-muted">
              {STACK_SELECTION_MODE_DESCRIPTIONS[mode]}
            </span>
          </span>
        </label>
      ))}
      {setMode.isError ? (
        <p role="alert" className="text-xs text-danger">
          {setMode.error.message}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * What a locked stack offers instead of editing.
 *
 * A reason is required, because reopening a locked stack invalidates whatever
 * was built on it — and a change nobody explained is one nobody can review.
 */
function LockedNotice({
  onUnlock,
  pending,
  error,
}: {
  readonly onUnlock: (reason: string) => void;
  readonly pending: boolean;
  readonly error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <p className="text-sm">
        This stack is locked. Later phases build on exactly these technologies, so it does not
        change by accident.
      </p>

      {open ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();

            if (reason.trim()) {
              onUnlock(reason.trim());
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Why are you reopening it?</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              className="rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>
          <p className="text-xs text-muted">
            The locked version is kept exactly as it is. You will be working on a new version, and
            anything already built on the old one will be marked out of date.
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !reason.trim()}>
              Reopen the stack
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
          Unlock and change it
        </Button>
      )}

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Infrastructure nothing in the requirements asked for.
 *
 * Behind a disclosure, not in the list. A cache, a queue, a search cluster or a
 * vector store each costs money to run for the life of the project, and putting
 * them on screen beside the frontend and the database is how a stack acquires
 * one because it was there to click. A user who knows they need one still can —
 * the capability is not removed, only the invitation.
 */
function ConditionalCategories({ stack }: { readonly stack: StackSnapshot }) {
  const [open, setOpen] = useState(false);
  const conditional = stack.categoryPlan.filter((entry) => entry.applicability === 'conditional');

  if (conditional.length === 0 || stack.status === 'LOCKED') {
    return null;
  }

  return (
    <div className="rounded-md border border-dashed border-border p-3">
      <Button variant="secondary" onClick={() => setOpen((was) => !was)}>
        {open ? 'Hide these' : 'Something else? (cache, search, queues and the like)'}
      </Button>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-muted">
            Nothing in your approved requirements asks for any of these. Add one only if you know
            why — each is a service somebody runs, and pays for, for the life of the project.
          </p>
          {conditional.map((entry) => (
            <CategoryRow
              key={entry.category}
              entry={entry}
              stack={stack}
              components={componentsIn(stack, entry.category)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The categories worth showing in the main list.
 *
 * `not_applicable` is filtered out entirely rather than shown greyed: a project
 * that does not have a mobile framework does not benefit from a row telling it
 * so twelve times. `conditional` is filtered out too, and moved behind the
 * disclosure above.
 */
function applicableCategories(
  plan: readonly CategoryApplicabilityEntry[],
): readonly CategoryApplicabilityEntry[] {
  const order = { required: 0, optional: 1, conditional: 2, not_applicable: 3 };

  return plan
    .filter((entry) => entry.applicability === 'required' || entry.applicability === 'optional')
    .sort(
      (first, second) =>
        order[first.applicability] - order[second.applicability] ||
        TECHNOLOGY_CATEGORY_LABELS[first.category].localeCompare(
          TECHNOLOGY_CATEGORY_LABELS[second.category],
        ),
    );
}

function componentsIn(stack: StackSnapshot, category: TechnologyCategory): StackComponent[] {
  return stack.components.filter(
    (component) =>
      component.category === category &&
      component.status !== 'SUPERSEDED' &&
      component.status !== 'REJECTED',
  );
}

function toneFor(status: StackSnapshot['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'APPROVED' || status === 'LOCKED') {
    return 'success';
  }

  if (status === 'OUTDATED' || status === 'REVIEW_REQUIRED') {
    return 'warning';
  }

  return 'neutral';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export { CATEGORY_APPLICABILITY_LABELS };
