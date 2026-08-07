'use client';

import { STACK_SNAPSHOT_STATUS_LABELS } from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useStackVersions } from '@/hooks/use-stack';

/**
 * Every version of the stack, and every decision inside the current one.
 *
 * Kept behind a disclosure because it is not what a user needs while they are
 * working — and kept at all because it is exactly what they need afterwards.
 * *"Who chose MySQL, and did they know the AI wanted PostgreSQL?"* is a question
 * asked weeks later, usually by somebody who was not in the room.
 */
export function StackHistory() {
  const { data } = useStackVersions();
  const [open, setOpen] = useState(false);

  const versions = data?.versions ?? [];

  if (versions.length === 0) {
    return null;
  }

  const current = versions[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          Every version is kept. A locked one keeps saying what it said when it was locked.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button variant="secondary" className="self-start" onClick={() => setOpen((was) => !was)}>
          {open ? 'Hide history' : 'Show what has been decided'}
        </Button>

        {open ? (
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2">
              {versions.map((version) => (
                <li
                  key={version.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
                >
                  <span>Stack v{version.version}</span>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{STACK_SNAPSHOT_STATUS_LABELS[version.status]}</Badge>
                    <span className="text-xs text-muted">
                      {version.components.length} technolog
                      {version.components.length === 1 ? 'y' : 'ies'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            {current && current.decisions.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium">Decisions on this version</h3>
                <ol className="mt-2 flex flex-col gap-1 text-xs">
                  {current.decisions.map((entry, index) => (
                    <li key={`${entry.kind}-${entry.decidedAt}-${index}`}>
                      <span className="text-muted">{formatTime(entry.decidedAt)}</span>{' '}
                      {entry.technologyName ? (
                        <span className="font-medium">{entry.technologyName}</span>
                      ) : null}{' '}
                      {entry.previousTechnologyName ? (
                        <span className="text-muted">
                          (replacing {entry.previousTechnologyName})
                        </span>
                      ) : null}{' '}
                      {entry.note}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
