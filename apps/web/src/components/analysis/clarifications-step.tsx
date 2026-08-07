'use client';

import { CLARIFICATION_CATEGORY_LABELS, type Clarification } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useAnswerClarification,
  useClarifications,
  useDismissClarification,
} from '@/hooks/use-analysis';

/**
 * The questions the analysis could not answer for itself.
 *
 * One control on this screen matters more than all the others: the choice
 * between recording an answer as a **fact from the client** and recording it as
 * an **assumption**. It is required rather than defaulted, because only the
 * person answering knows which it is, and an assumption filed as a fact is the
 * most expensive mistake a requirement document can carry — it looks exactly
 * like something the client said, right up until they read it.
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
  const open = clarifications.filter((item) => item.status === 'open');
  const settled = clarifications.filter((item) => item.status !== 'open');

  return (
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="clarifications-title">
        <CardHeader>
          <CardTitle id="clarifications-title">Clarification questions</CardTitle>
          <CardDescription>
            Written for a business reader, one issue each. The ones marked as blocking stop the
            baseline being approved until they are answered or dismissed.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {clarifications.length === 0 ? (
            <p className="text-sm text-muted">
              No questions yet. Run the analysis first — questions come out of what it finds.
            </p>
          ) : null}

          {open.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {open.map((clarification) => (
                <ClarificationRow key={clarification.id} clarification={clarification} />
              ))}
            </ul>
          ) : clarifications.length > 0 ? (
            <p className="text-sm text-muted">Every question has been dealt with.</p>
          ) : null}
        </CardContent>
      </Card>

      {settled.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Answered</CardTitle>
            <CardDescription>
              Answers are evidence. Anything recorded as an assumption appears in the baseline
              labelled as one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {settled.map((clarification) => (
                <li key={clarification.id} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">{clarification.key}</span>
                    <Badge tone={clarification.status === 'dismissed' ? 'neutral' : 'success'}>
                      {clarification.status === 'dismissed' ? 'Dismissed' : 'Answered'}
                    </Badge>
                    {clarification.answer?.isAssumption ? (
                      <Badge tone="warning">Recorded as an assumption</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm font-medium">{clarification.question}</p>
                  {clarification.answer ? (
                    <p className="mt-1 text-sm">{clarification.answer.text}</p>
                  ) : null}
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

function ClarificationRow({ clarification }: { readonly clarification: Clarification }) {
  const [text, setText] = useState('');
  const [isAssumption, setIsAssumption] = useState<boolean | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const answer = useAnswerClarification();
  const dismiss = useDismissClarification();

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{clarification.key}</span>
        <Badge tone="neutral">{CLARIFICATION_CATEGORY_LABELS[clarification.category]}</Badge>
        {clarification.blocksApproval ? <Badge tone="danger">Blocks approval</Badge> : null}
      </div>

      <h3 className="mt-1 font-medium">{clarification.question}</h3>
      <p className="mt-1 text-xs text-muted">{clarification.rationale}</p>

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

            answer.mutate({
              clarificationId: clarification.id,
              text,
              isAssumption,
              integrateNow: false,
              expectedVersion: clarification.version,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Answer</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              required
              className="rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>

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
                  It becomes a requirement, like anything else they told you.
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
              {answer.isPending ? 'Saving…' : 'Save the answer'}
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
