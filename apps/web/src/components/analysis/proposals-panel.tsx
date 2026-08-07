'use client';

import { PROPOSAL_REASON_MESSAGES, type RequirementItem } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useProposals, useResolveProposal } from '@/hooks/use-analysis';

/**
 * Revisions a clarification proposed, waiting for a person.
 *
 * These exist because the answer touched a requirement that must not be
 * rewritten automatically — one somebody edited, wrote, or already approved. The
 * screen's whole job is to make the decision easy and the difference obvious:
 * the current wording and the proposed wording side by side, why the change is
 * being proposed, and which clarification it came from.
 *
 * There is no bulk accept. Each of these is a decision about one requirement,
 * and a control that applies twenty at once is an invitation to not read them.
 */
export function ProposalsPanel() {
  const { data, isPending } = useProposals();
  const proposals = data ?? [];

  if (isPending || proposals.length === 0) {
    return null;
  }

  return (
    <Card role="region" aria-labelledby="proposals-title">
      <CardHeader>
        <CardTitle id="proposals-title">Proposed changes ({proposals.length})</CardTitle>
        <CardDescription>
          A confirmed answer would change these requirements, but each is one you edited, wrote or
          approved — so nothing has been applied. Read each proposal and decide.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ul className="flex flex-col gap-4">
          {proposals.map((item) => (
            <ProposalRow key={item.id} item={item} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ProposalRow({ item }: { readonly item: RequirementItem }) {
  const proposal = item.proposedRevision;
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(proposal?.proposedStatement ?? '');
  const resolve = useResolveProposal();

  if (!proposal) {
    return null;
  }

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{item.key}</span>
        <Badge tone="info">From {proposal.clarificationKey}</Badge>
        <Badge tone="warning">Waiting for you</Badge>
      </div>

      <p className="mt-2 text-sm">{PROPOSAL_REASON_MESSAGES[proposal.proposalReason]}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-surface-raised p-3">
          <p className="text-xs font-medium text-muted">Current wording</p>
          <p className="mt-1 text-sm">{proposal.currentStatement}</p>
        </div>
        <div className="rounded-md border border-accent/40 bg-accent-soft p-3">
          <p className="text-xs font-medium text-accent">Proposed wording</p>
          <p className="mt-1 text-sm">{proposal.proposedStatement}</p>
        </div>
      </div>

      {/* Why, in the reviewer's terms — the question and the confirmed answer,
          never the model's raw output. */}
      <p className="mt-3 rounded-md border border-border p-2 text-xs text-muted">
        <span className="font-medium">Why: </span>
        {proposal.reason}
      </p>

      {editing ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            resolve.mutate({
              itemId: item.id,
              decision: 'edit',
              statement,
              expectedVersion: item.version,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Your wording</span>
            <textarea
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              rows={3}
              required
              className="rounded-md border border-border px-2 py-1 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={resolve.isPending}>
              Save this wording
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                itemId: item.id,
                decision: 'accept',
                expectedVersion: item.version,
              })
            }
          >
            Accept the proposed update
          </Button>
          <Button
            variant="secondary"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate({
                itemId: item.id,
                decision: 'reject',
                expectedVersion: item.version,
              })
            }
          >
            Keep the current requirement
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit the proposed wording
          </Button>
        </div>
      )}

      {resolve.isError ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {resolve.error.message}
        </p>
      ) : null}
    </li>
  );
}
