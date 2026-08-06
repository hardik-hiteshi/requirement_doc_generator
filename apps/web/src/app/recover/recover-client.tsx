'use client';

import { useQueryClient } from '@tanstack/react-query';
import { parseRecoveryFragment } from '@wdrg/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { ApiClientError } from '@/lib/api-client';
import { exchangeRecoverySecret } from '@/lib/project-api';
import { queryKeys } from '@/lib/query-keys';

type RecoveryState =
  | { status: 'reading' }
  | { status: 'exchanging' }
  | { status: 'success' }
  | { status: 'invalid-link' }
  | { status: 'denied'; message: string };

/**
 * Redeems a recovery link.
 *
 * The secret arrives in the URL **fragment**, which the browser never sends to
 * a server — so it cannot appear in an access log, a proxy log or a `Referer`
 * header. This component reads it, exchanges it for a session cookie, and then
 * removes it from the address bar with `history.replaceState` so it does not
 * survive in browser history or get copied out of a shared screenshot.
 */
export function RecoverClient() {
  const [state, setState] = useState<RecoveryState>({ status: 'reading' });
  const queryClient = useQueryClient();
  // React 18+ mounts effects twice in development StrictMode; the exchange is a
  // one-shot operation against a single-use fragment, so it must not run twice.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) {
      return;
    }

    attempted.current = true;

    const parsed = parseRecoveryFragment(window.location.hash);

    if (!parsed) {
      // Deferred to a microtask: setting state synchronously inside an effect
      // body triggers a cascading render.
      queueMicrotask(() => setState({ status: 'invalid-link' }));
      return;
    }

    // Clear the secret from the address bar before the network call, so it is
    // gone even if the exchange is slow or the user navigates away mid-flight.
    window.history.replaceState(null, '', window.location.pathname);
    queueMicrotask(() => setState({ status: 'exchanging' }));

    exchangeRecoverySecret(parsed.projectId, parsed.recoverySecret)
      .then((response) => {
        queryClient.setQueryData(queryKeys.currentProject, response.project);
        setState({ status: 'success' });
        window.location.replace('/');
      })
      .catch((error: unknown) => {
        setState({
          status: 'denied',
          message:
            error instanceof ApiClientError
              ? error.message
              : 'This project could not be opened. Please check your recovery link.',
        });
      });
  }, [queryClient]);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl items-center px-6 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Opening your project</CardTitle>
          <CardDescription aria-live="polite">
            {state.status === 'reading' || state.status === 'exchanging'
              ? 'Checking your recovery link…'
              : null}
            {state.status === 'success' ? 'Recovered. Taking you to your workspace…' : null}
            {state.status === 'invalid-link'
              ? 'That link does not look like a recovery link.'
              : null}
            {state.status === 'denied' ? state.message : null}
          </CardDescription>
        </CardHeader>

        {state.status === 'invalid-link' || state.status === 'denied' ? (
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              Recovery links look like{' '}
              <code className="font-mono text-xs">https://…/recover#p=prj_…&amp;s=…</code>. Make
              sure you copied the whole link, including everything after the <code>#</code>.
            </p>
            <p className="text-sm text-muted">
              If the project was deleted, or has expired, it cannot be reopened.
            </p>
            <Button asChild className="self-start">
              <Link href="/">Start a new project</Link>
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </main>
  );
}
