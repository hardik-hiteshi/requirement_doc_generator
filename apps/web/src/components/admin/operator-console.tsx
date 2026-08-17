'use client';

import type {
  AdminAuditResponse,
  AdminProjectDetail,
  AdminProjectList,
  AdminQueueState,
  AdminStatus,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  AdminApiError,
  readAdminAudit,
  readAdminProject,
  readAdminProjects,
  readAdminQueue,
  readAdminStatus,
  retryExtractionJob,
  runRetentionSweep,
} from '@/lib/admin-api';

/**
 * What an operator sees.
 *
 * The four questions this answers are the ones support work starts with: is the system
 * healthy, is anything stuck, what is happening with this project, and what has been
 * refused. Everything on the page is a read except two buttons — a retention sweep and
 * a job retry — and both do exactly what the scheduled machinery already does.
 *
 * ## The token lives in this component and nowhere else
 *
 * Held in `useState` for the life of the tab, passed to each call, never written to
 * `localStorage` or a cookie. Closing the tab ends the session. That is deliberately
 * less convenient than persisting it: this is a deployment secret that reads an audit
 * trail, and a shared machine should not remember it.
 *
 * ## No auto-refresh
 *
 * Everything is fetched when asked for. A dashboard that polls a rate-limited API every
 * few seconds spends an operator's budget on being open, and the questions here are
 * asked deliberately rather than watched.
 */
export function OperatorConsole() {
  const [token, setToken] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const [status, setStatus] = useState<AdminStatus | undefined>(undefined);
  const [queue, setQueue] = useState<AdminQueueState | undefined>(undefined);
  const [audit, setAudit] = useState<AdminAuditResponse | undefined>(undefined);
  const [projects, setProjects] = useState<AdminProjectList | undefined>(undefined);
  const [project, setProject] = useState<AdminProjectDetail | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [jobId, setJobId] = useState('');

  /**
   * Runs one operator request, reporting a failure rather than swallowing it.
   *
   * Returns `undefined` when the call failed, and callers must check it before chaining
   * a refresh: a follow-up `guard` clears the error first, so refreshing unconditionally
   * after a failed action erased the message explaining what went wrong a moment after
   * showing it.
   */
  async function guard<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(undefined);

    try {
      return await work();
    } catch (caught) {
      setError(
        caught instanceof AdminApiError
          ? caught.message
          : 'The operator surface could not be reached.',
      );

      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  async function signIn(): Promise<void> {
    /*
     * "Signing in" is one request that either works or does not. There is no session to
     * establish — the token is the credential on every call — so the only thing being
     * established here is whether it is accepted.
     */
    const result = await guard('sign-in', () => readAdminStatus(token));

    if (result) {
      setStatus(result);
      setAuthenticated(true);
    }
  }

  const refreshStatus = () =>
    guard('status', () => readAdminStatus(token)).then((value) => value && setStatus(value));

  const refreshQueue = () =>
    guard('queue', () => readAdminQueue(token)).then((value) => value && setQueue(value));

  const refreshAudit = () =>
    guard('audit', () => readAdminAudit(token)).then((value) => value && setAudit(value));

  const findProjects = () =>
    guard('projects', () => readAdminProjects(token, search.trim() || undefined)).then(
      (value) => value && setProjects(value),
    );

  const openProject = (projectId: string) =>
    guard('project', () => readAdminProject(token, projectId)).then(
      (value) => value && setProject(value),
    );

  if (!authenticated) {
    return (
      <Card role="region" aria-label="Operator sign in">
        <CardHeader>
          <CardTitle>Operator console</CardTitle>
          <CardDescription>
            Enter the deployment&apos;s operator token. It is held for this tab only and is never
            stored in the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Operator token</span>
            <input
              type="password"
              className="rounded-md border border-border bg-surface px-2 py-1"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              data-testid="admin-token"
              autoComplete="off"
            />
          </label>

          <div>
            <Button
              onClick={() => void signIn()}
              disabled={token.length === 0 || busy !== undefined}
              data-testid="admin-sign-in"
            >
              {busy === 'sign-in' ? 'Checking…' : 'Open console'}
            </Button>
          </div>

          {error && (
            <p className="text-sm text-danger" role="alert" data-testid="admin-error">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="admin-error">
          {error}
        </p>
      )}

      <Card role="region" aria-label="System status">
        <CardHeader>
          <CardTitle>System status</CardTitle>
          <CardDescription>
            Counters and the last retention sweep are per process: they reset when the API restarts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {status && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" data-testid="admin-environment">
                  {status.environment}
                </Badge>
                <Badge tone="neutral">v{status.version}</Badge>
                <Badge tone={status.rateLimit.enabled ? 'success' : 'warning'}>
                  Rate limits {status.rateLimit.enabled ? 'on' : 'off'}
                </Badge>
                <Badge tone={status.retention.enabled ? 'success' : 'warning'}>
                  Retention {status.retention.enabled ? 'on' : 'off'}
                </Badge>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                {Object.entries(status.projects).map(([state, count]) => (
                  <div key={state} className="rounded-md border border-border p-2">
                    <dt className="text-xs text-muted">{state}</dt>
                    <dd data-testid={`admin-projects-${state}`}>{count}</dd>
                  </div>
                ))}
                <div className="rounded-md border border-border p-2">
                  <dt className="text-xs text-muted">Awaiting deletion</dt>
                  <dd data-testid="admin-pending-deletion">{status.retention.pendingDeletion}</dd>
                </div>
              </dl>
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void refreshStatus()}
              data-testid="admin-refresh-status"
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void guard('sweep', () => runRetentionSweep(token)).then(
                  (result) => result && refreshStatus(),
                )
              }
              disabled={busy !== undefined}
              data-testid="admin-run-retention"
            >
              {busy === 'sweep' ? 'Sweeping…' : 'Run retention sweep'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card role="region" aria-label="Extraction queue">
        <CardHeader>
          <CardTitle>Extraction queue</CardTitle>
          <CardDescription>
            A claimed job older than the reclaim window means a worker stopped and nothing has
            picked the job up yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {queue ? (
            <>
              {queue.stalled && (
                <p className="text-sm text-danger" data-testid="admin-queue-stalled">
                  A job has been claimed for longer than the reclaim window.
                </p>
              )}
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                {Object.entries(queue.counts).map(([state, count]) => (
                  <div key={state} className="rounded-md border border-border p-2">
                    <dt className="text-xs text-muted">{state}</dt>
                    <dd data-testid={`admin-queue-${state}`}>{count}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-muted" data-testid="admin-queue-ages">
                Oldest queued: {queue.oldestQueuedSeconds ?? 0}s · oldest claimed:{' '}
                {queue.oldestClaimedSeconds ?? 0}s · reclaim after {queue.claimTimeoutSeconds}s
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">Not loaded yet.</p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <Button
              variant="secondary"
              onClick={() => void refreshQueue()}
              data-testid="admin-refresh-queue"
            >
              {busy === 'queue' ? 'Loading…' : 'Load queue'}
            </Button>

            <label className="flex flex-col gap-1 text-sm">
              <span>Retry a job by id</span>
              <input
                className="rounded-md border border-border bg-surface px-2 py-1"
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                data-testid="admin-job-id"
              />
            </label>

            <Button
              variant="secondary"
              onClick={() =>
                void guard('retry', () => retryExtractionJob(token, jobId.trim())).then(
                  (result) => result && refreshQueue(),
                )
              }
              disabled={jobId.trim().length === 0 || busy !== undefined}
              data-testid="admin-retry-job"
            >
              {busy === 'retry' ? 'Retrying…' : 'Retry job'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card role="region" aria-label="Projects">
        <CardHeader>
          <CardTitle>Projects</CardTitle>
          <CardDescription>
            Metadata and counts only. No requirement text, no document content, no recovery secret —
            searching by id, because a name search over client names is a directory.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Project id (leave empty for the most recently active)</span>
            <input
              className="rounded-md border border-border bg-surface px-2 py-1"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              data-testid="admin-project-search"
            />
          </label>

          <div>
            <Button
              variant="secondary"
              onClick={() => void findProjects()}
              data-testid="admin-find-projects"
            >
              {busy === 'projects' ? 'Searching…' : 'Find projects'}
            </Button>
          </div>

          {projects && (
            <ul className="flex flex-col gap-2" data-testid="admin-project-list">
              {projects.projects.length === 0 && (
                <li className="text-sm text-muted">No project matched.</li>
              )}
              {projects.projects.map((entry) => (
                <li
                  key={entry.projectId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
                >
                  <span className="font-mono text-xs">{entry.projectId}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">{entry.effectiveStatus}</Badge>
                    <Button
                      variant="secondary"
                      onClick={() => void openProject(entry.projectId)}
                      data-testid={`admin-open-${entry.projectId}`}
                    >
                      Inspect
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {project && (
            <div
              className="rounded-md border border-border p-3 text-sm"
              data-testid="admin-project-detail"
            >
              <p className="font-mono text-xs">{project.projectId}</p>
              <p>
                Stored {project.status} · effective {project.effectiveStatus} · expires{' '}
                {project.expiresAt.slice(0, 10)}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(project.counts).map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd data-testid={`admin-count-${label}`}>{count}</dd>
                  </div>
                ))}
              </dl>
              {Object.keys(project.unfinishedJobs).length > 0 && (
                <p className="mt-2" data-testid="admin-unfinished-jobs">
                  Unfinished jobs:{' '}
                  {Object.entries(project.unfinishedJobs)
                    .map(([state, count]) => `${state} ${count}`)
                    .join(' · ')}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-label="Recent audit events">
        <CardHeader>
          <CardTitle>Recent audit events</CardTitle>
          <CardDescription>
            Newest first. Metadata is written to a policy that keeps document content out of it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {audit ? (
            <ul className="flex flex-col gap-1 text-sm" data-testid="admin-audit-list">
              {audit.events.map((event, index) => (
                <li
                  key={`${event.occurredAt}-${index}`}
                  className="flex flex-wrap items-baseline gap-2 border-b border-border pb-1"
                >
                  <span className="font-mono text-xs">{event.occurredAt.slice(11, 19)}</span>
                  <span>{event.type}</span>
                  <span className="font-mono text-xs text-muted">{event.projectId}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Not loaded yet.</p>
          )}

          <div>
            <Button
              variant="secondary"
              onClick={() => void refreshAudit()}
              data-testid="admin-refresh-audit"
            >
              {busy === 'audit' ? 'Loading…' : 'Load recent events'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
