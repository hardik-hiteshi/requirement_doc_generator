'use client';

import {
  CLARIFICATION_CATEGORY_LABELS,
  CLARIFICATION_STATUS_LABELS,
  currentAnswer,
  SETTLED_CLARIFICATION_STATUSES,
  type Clarification,
  type ClarificationStatus,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useAnswerClarification,
  useClarifications,
  useConfirmClarification,
  useDismissClarification,
} from '@/hooks/use-analysis';
import { ProposalsPanel } from './proposals-panel';

/**
 * The questions the analysis could not answer for itself.
 *
 * Two controls on this screen carry more weight than the rest.
 *
 * **Answering is not confirming.** An answer typed after a meeting and an answer
 * the client has agreed to are different things, and only the second rewrites
 * requirements. So answering stores the text and stops; confirming is a separate,
 * deliberate act, and it is the moment text somebody typed becomes evidence.
 *
 * **Fact or assumption** is required, never defaulted. A confirmed fact updates
 * the requirements it affects and is cited by them. An assumption is recorded as
 * an assumption, labelled, so the client can see what was taken for granted.
 * Only the person in the room knows which it is.
 */
export function ClarificationsStep() {
  const { data, isPending } = useClarifications();

  if (isPending) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted">Loading questions…</p>
        </CardContent>
      </Card>
    );
  }

  const clarifications = data ?? [];
  const outstanding = clarifications.filter(
    (item) => !SETTLED_CLARIFICATION_STATUSES.includes(item.status),
  );
  const settled = clarifications.filter((item) =>
    SETTLED_CLARIFICATION_STATUSES.includes(item.status),
  );

  return (
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="clarifications-title">
        <CardHeader>
          <CardTitle id="clarifications-title">Clarification questions</CardTitle>
          <CardDescription>
            Written for a business reader, one issue each. A confirmed answer becomes evidence: the
            requirements it affects are updated and cite it. The ones marked as blocking stop the
            baseline being approved until they are settled.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {clarifications.length === 0 ? (
            <p className="text-sm text-muted">
              No questions yet. Run the analysis first — questions come out of what it finds.
            </p>
          ) : null}

          {outstanding.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {outstanding.map((clarification) => (
                <ClarificationRow key={clarification.id} clarification={clarification} />
              ))}
            </ul>
          ) : clarifications.length > 0 ? (
            <p className="text-sm text-muted">Every question has been dealt with.</p>
          ) : null}
        </CardContent>
      </Card>

      <ProposalsPanel />

      {settled.length > 0 ? (
        <Card role="region" aria-labelledby="settled-clarifications-title">
          <CardHeader>
            <CardTitle id="settled-clarifications-title">Settled</CardTitle>
            <CardDescription>
              Confirmed answers are evidence, cited by the requirements they changed. Anything
              recorded as an assumption appears in the baseline labelled as one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {settled.map((clarification) => (
                <li key={clarification.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">{clarification.key}</span>
                    <StatusBadge status={clarification.status} />
                    {currentAnswer(clarification)?.isAssumption ? (
                      <Badge tone="warning">Recorded as an assumption</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm font-medium">{clarification.question}</p>
                  <AnswerHistory clarification={clarification} />
                  {clarification.dismissedReason ? (
                    <p className="mt-1 text-sm text-muted">{clarification.dismissedReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { readonly status: ClarificationStatus }) {
  const tone =
    status === 'INTEGRATED'
      ? 'success'
      : status === 'FAILED'
        ? 'danger'
        : status === 'NEEDS_REVIEW'
          ? 'warning'
          : status === 'INTEGRATING'
            ? 'info'
            : 'neutral';

  return <Badge tone={tone}>{CLARIFICATION_STATUS_LABELS[status]}</Badge>;
}

/** Every version, so a superseded answer stays readable beside the current one. */
function AnswerHistory({ clarification }: { readonly clarification: Clarification }) {
  if (clarification.answers.length === 0) {
    return null;
  }

  return (
    <ul className="mt-2 flex flex-col gap-2">
      {[...clarification.answers].reverse().map((answer) => (
        <li
          key={answer.version}
          className={`rounded-md border p-2 text-sm ${
            answer.status === 'current' ? 'border-border' : 'border-border/50 text-muted'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono">v{answer.version}</span>
            {answer.status === 'superseded' ? (
              <Badge tone="neutral">Replaced by v{answer.supersededByVersion}</Badge>
            ) : null}
            {answer.confirmedAt ? <Badge tone="success">Confirmed</Badge> : null}
            {answer.isAssumption ? <Badge tone="warning">Assumption</Badge> : null}
          </div>
          <p className="mt-1">{answer.text}</p>
          {answer.failureReason ? (
            <p className="mt-1 text-xs text-danger">{answer.failureReason}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ClarificationRow({ clarification }: { readonly clarification: Clarification }) {
  const [text, setText] = useState('');
  const [isAssumption, setIsAssumption] = useState<boolean | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const answer = useAnswerClarification();
  const confirm = useConfirmClarification();
  const dismiss = useDismissClarification();

  const current = currentAnswer(clarification);
  const awaitingConfirmation = current !== undefined && current.confirmedAt === undefined;

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{clarification.key}</span>
        <Badge tone="neutral">{CLARIFICATION_CATEGORY_LABELS[clarification.category]}</Badge>
        <StatusBadge status={clarification.status} />
        {clarification.blocksApproval ? <Badge tone="danger">Blocks approval</Badge> : null}
      </div>

      <h3 className="mt-1 font-medium">{clarification.question}</h3>
      <p className="mt-1 text-xs text-muted">{clarification.rationale}</p>

      <AnswerHistory clarification={clarification} />

      {clarification.status === 'INTEGRATING' ? (
        <p className="mt-3 text-sm text-muted" role="status">
          Applying the answer to the requirements it affects…
        </p>
      ) : null}

      {clarification.status === 'FAILED' ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          The answer could not be applied, and nothing was changed. Confirm it again to retry.
        </p>
      ) : null}

      {/* Confirming is its own act. Until it happens the answer is text
          somebody typed, and the question still blocks approval. */}
      {awaitingConfirmation ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-accent/40 bg-accent-soft p-3">
          <p className="text-sm">
            {current.isAssumption
              ? 'Confirming records this as an assumption, labelled as one in the baseline.'
              : 'Confirming applies this answer to the requirements it affects, which will then cite it as evidence.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={confirm.isPending}
              onClick={() =>
                confirm.mutate({
                  clarificationId: clarification.id,
                  expectedVersion: clarification.version,
                })
              }
            >
              {confirm.isPending ? 'Applying…' : 'Confirm this answer'}
            </Button>
          </div>
          {confirm.isError ? (
            <p role="alert" className="text-xs text-danger">
              {confirm.error.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {dismissing ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            dismiss.mutate({
              clarificationId: clarification.id,
              reason,
              expectedVersion: clarification.version,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Why is this not worth asking?</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              className="rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={dismiss.isPending}>
              Dismiss
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();

            if (isAssumption === null) {
              return;
            }

            answer.mutate(
              {
                clarificationId: clarification.id,
                text,
                isAssumption,
                expectedVersion: clarification.version,
              },
              { onSuccess: () => setText('') },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{current ? 'Change the answer' : 'Answer'}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              required
              className="rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>

          {current ? (
            <p className="text-xs text-muted">
              A new answer replaces this one. The old version is kept, the requirements it changed
              are marked for another look, and an approved baseline goes out of date.
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium">Where does this answer come from?</legend>
            {/*
              No default. The application cannot know which of these is true, and
              choosing one for the user is exactly the mistake this control
              exists to prevent.
            */}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`origin-${clarification.id}`}
                checked={isAssumption === false}
                onChange={() => setIsAssumption(false)}
                className="mt-1"
                required
              />
              <span>
                The client confirmed it
                <span className="block text-xs text-muted">
                  It becomes evidence. The requirements it affects are updated and cite it.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`origin-${clarification.id}`}
                checked={isAssumption === true}
                onChange={() => setIsAssumption(true)}
                className="mt-1"
              />
              <span>
                We are assuming it
                <span className="block text-xs text-muted">
                  It is recorded in the baseline as an assumption, labelled as one, so the client
                  can see what was taken for granted.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={answer.isPending || isAssumption === null}>
              {answer.isPending ? 'Saving…' : current ? 'Save the new answer' : 'Save the answer'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDismissing(true)}>
              Not worth asking
            </Button>
          </div>

          {answer.isError ? (
            <p role="alert" className="text-xs text-danger">
              {answer.error.message}
            </p>
          ) : null}
        </form>
      )}
    </li>
  );
}
