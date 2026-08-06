'use client';

import { RECOVERY_WARNING } from '@wdrg/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

export interface RecoveryLinkPanelProps {
  readonly recoveryLink: string;
  /** Shown after creation, where the user must acknowledge before continuing. */
  readonly requireAcknowledgement?: boolean;
  readonly onAcknowledged?: () => void;
}

/**
 * The reusable private recovery link, and the warning that goes with it.
 *
 * With no accounts, this link *is* the project's recovery credential: it works
 * again from any device, for as long as the project does. What happens only
 * once is *seeing* it — the server keeps a hash, so it cannot be shown again.
 *
 * The panel is deliberately heavy-handed about that distinction: the warning is
 * stated in full, the link sits in a read-only field the user can select, and
 * after creation they must tick a box confirming they saved it. A user who
 * loses this cannot be helped by anyone.
 */
export function RecoveryLinkPanel({
  recoveryLink,
  requireAcknowledgement = false,
  onAcknowledged,
}: RecoveryLinkPanelProps) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    setCopyFailed(false);

    try {
      await navigator.clipboard.writeText(recoveryLink);
      setCopied(true);
      // Reverting the label keeps the button honest if the user copies again.
      setTimeout(() => setCopied(false), 3_000);
    } catch {
      // Clipboard access can be denied or unavailable (insecure context, older
      // browser). Say so rather than silently appearing to succeed.
      setCopyFailed(true);
    }
  }

  return (
    <Card
      role="region"
      aria-labelledby="recovery-link-title"
      className="border-warning/40 bg-warning-soft"
    >
      <CardHeader>
        <CardTitle id="recovery-link-title">Save your private recovery link</CardTitle>
        <CardDescription>{RECOVERY_WARNING}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="recovery-link" className="sr-only">
            Recovery link
          </label>
          <input
            id="recovery-link"
            readOnly
            value={recoveryLink}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground"
          />
          <Button type="button" onClick={() => void copy()} className="shrink-0">
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>

        <span role="status" aria-live="polite" className="text-xs">
          {copied ? (
            <span className="text-success">Recovery link copied to the clipboard.</span>
          ) : null}
          {copyFailed ? (
            <span className="text-danger">
              Could not copy automatically. Select the link above and copy it manually.
            </span>
          ) : null}
        </span>

        {requireAcknowledgement ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <div className="flex items-start gap-2.5">
              <input
                id="acknowledge-recovery"
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                className="mt-0.5 size-4 shrink-0 rounded border-border"
              />
              <label htmlFor="acknowledge-recovery" className="text-sm">
                I have saved this recovery link somewhere safe. I understand it will not be shown
                again.
              </label>
            </div>

            <Button
              type="button"
              disabled={!acknowledged}
              onClick={onAcknowledged}
              className="self-start"
            >
              Continue to the workspace
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
