# The operator surface

Four endpoints for whoever runs the deployment: what the instance is doing, what has been
refused, metrics to scrape, and a way to run a retention sweep now.

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

## Read-mostly by design

Three of the four endpoints read. The fourth triggers scheduled work that would have
happened anyway. Nothing here edits a project, changes a document, alters a status or
adjusts a limit — the operator surface exists to _see_ the system, and a surface that can
change it is a surface whose token is worth stealing.
