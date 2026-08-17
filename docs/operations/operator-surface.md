# The operator surface

Nine endpoints and a console for whoever runs the deployment: what the instance is doing,
what is stuck, what is happening with one project, what has been refused, metrics to
scrape, and two actions that make scheduled work happen sooner.

**Absent by default.** With no `ADMIN_API_TOKEN` configured the routes answer `404`, so a
deployment that has not enabled the surface is indistinguishable from one where it does not
exist.

## Authentication, and why it is a token

There are no user accounts in this system. A project _is_ the principal — reached with a
recovery secret, carrying no owner, no roles and no directory. Adding sign-in for operators
would mean inventing an identity system, a password policy, a reset flow and a lockout
policy for a surface with one user, and every one of those is a new thing to get wrong.

So authentication is a single deployment secret in `ADMIN_API_TOKEN`, sent as
`x-admin-token`, compared in constant time, never logged and never echoed.

**The honest trade:** there is no per-operator attribution. `ADMIN_ACTION` records that an
operator acted, not which one. Where several people share a deployment they share a token,
and the audit trail says so rather than implying otherwise. If you need attribution, put
the surface behind a reverse proxy that authenticates individuals and logs them.

Production requires at least 32 characters when the token is set at all.

## Endpoints

All are excluded from the OpenAPI document. It is served publicly in non-production and
describes the client API; advertising an operator surface there tells every reader where to
look and what to send.

### `GET /api/v1/admin/status`

Project counts by status, retention configuration and the last sweep of this process,
rate-limit state including refusals by class, and which storage and scanner adapters are
active.

```
curl -s https://your-host/api/v1/admin/status -H "x-admin-token: $ADMIN_API_TOKEN"
```

`rateLimit.refusals` and `retention.lastSweep` are **per process**: they reset when the API
restarts, and behind several instances each reports its own.

### `GET /api/v1/admin/audit`

Recent audit events, newest first. Filters: `type`, `projectId`, `since` (ISO 8601),
`limit` (1–200, default 50). `truncated` tells you the limit cut the result, so you know to
narrow it.

There is deliberately **no free-text search over metadata**. Metadata is written to a policy
that keeps document content, row text and credentials out of it, and a search interface over
it would invite putting content in.

An unrecognised filter is rejected rather than ignored, so a typo does not silently return
everything.

### `GET /api/v1/admin/projects`

Projects by status, or one by exact id, newest activity first. **Metadata only.**

Deliberately no name search. Project names are client names, and a substring search over
them turns an operator surface into a client directory — useful for support once, useful
for reconnaissance always. An operator handling a support request has the id, because it
is what the user can read off their own link.

### `GET /api/v1/admin/projects/:projectId`

One project: status, the _derived_ status beside it, timestamps, expiry, and counts of
sources, requirement items, documents, versions, jobs and audit events — plus unfinished
extraction jobs by state.

The difference between `status` and `effectiveStatus` is the answer to "why can't they
edit it": expiry is derived on access, so a record can say `ACTIVE` while every write is
already refused.

**What this never returns:** requirement text, document content, exported files, recovery
secrets, stored payloads, or MongoDB's own `_id`. Not redacted — absent. The fields are
restricted at the database query, so content never enters the process's memory, and an
integration test reads the serialised response to confirm it.

Every view is recorded as `ADMIN_PROJECT_VIEWED`, including a lookup of a project that
does not exist — which is what a probe looks like.

### `GET /api/v1/admin/queue`

Extraction queue depth by state, the age of the oldest queued and oldest claimed job, the
reclaim window, and `stalled` when a claimed job has outlived it.

This is the failure this system has that nothing surfaced before: an upload succeeds, the
worker that claimed the job dies, and the first signal was a person saying it had been
like that for an hour.

### `POST /api/v1/admin/queue/:jobId/retry`

Sends a failed job back to the queue, through the same port the ingestion path uses. A
job that does not exist, or is not in a retryable state, answers `404` identically — an
operator cannot use the distinction to discover which job ids exist. Recorded as
`ADMIN_JOB_RETRIED` whether or not it succeeds.

### `GET /api/v1/admin/config`

The configuration this process actually resolved, so an operator does not need shell
access to answer "what is this instance running with".

Allow-listed by exact key, not deny-listed: the failure modes are not symmetrical.
Forgetting to add a safe key means somebody asks a question; forgetting to deny a new
secret means publishing it. Secrets appear only in `secretsConfigured` as `true`/`false`
— never a value, never a length.

### `POST /api/v1/admin/retention/run`

Runs a retention sweep now and returns what it did. See
[retention.md](retention.md#running-one-by-hand).

### `GET /api/v1/admin/metrics`

Prometheus exposition text — a name, optional labels, a number:

```
# HELP wdrg_rate_limit_refusals_total Requests refused by a rate ceiling, by class.
# TYPE wdrg_rate_limit_refusals_total counter
wdrg_rate_limit_refusals_total{class="export"} 3
```

No client library, no agent, no sidecar and no account: point whatever collector you
already run at it. A hosted monitoring vendor would give dashboards for a subscription;
this gives the same numbers to something you own.

Counters and gauges only, and few of them — each answers a question an operator actually
asks: is anything being refused, is the retention job running, are exports happening.
Histograms and per-route timings are absent because they multiply series by route and
status and nothing here consumes them yet.

**No label identifies a project.** A metric is retained far longer than an audit event and
is often visible more widely, so labels come from closed sets — a class, a format, an
outcome — never from a path or an id.

Scraping is not audited: a collector reads this every few seconds, and recording each one
would fill the trail with the fact that monitoring works.

## What a refusal looks like

Absent, malformed and wrong tokens all answer identically — `401`, with nothing about what
was expected. Every refusal is recorded as `ADMIN_ACCESS_DENIED` with the reason and the
method, and never the token or its length. A wrong token is the signal that somebody is
trying, and it is the thing an operator most wants to find in the trail.

## The console

`/admin` in the web application renders status, project search, project metadata, queue
state and recent audit events.

The token is entered per session and held **in memory for the life of the tab**. Not
`localStorage`, which survives the tab and is readable by any script that ever runs on
the origin; not a cookie, which would be attached to requests that do not need it.
Closing the tab ends the session — deliberately less convenient than remembering it, for
a deployment secret that reads an audit trail.

Nothing polls. A dashboard refreshing itself every few seconds would spend the operator's
own rate-limit budget on being open, and these questions are asked deliberately rather
than watched. The page is `noindex`, and nothing in the client workspace links to it.

## Read-mostly by design

Seven of the nine endpoints read. The two that act — a retention sweep and a job retry —
both do exactly what the scheduled machinery already does, and neither can purge or
change anything the configured policy would not have handled on its own.

Nothing here edits a project, changes a document, alters a status or adjusts a limit. The
operator surface exists to _see_ the system, and a surface that can change it is a surface
whose token is worth stealing.

Phase 13 widened what one token can see, by adding per-project reads. That is a real
increase in blast radius, and the controls on it are the ones above: metadata only,
enforced at the query; every view audited; and no search that could enumerate clients.
