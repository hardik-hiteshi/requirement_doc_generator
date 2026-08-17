# Observability

What this service tells you about itself, and what it deliberately does not.

Everything here is emitted by the application into a small in-process registry and
rendered as Prometheus exposition text at `GET /api/v1/admin/metrics`. No client
library, no agent, no sidecar, no account — point whatever collector you already run at
it.

## The metrics

| Metric                                 | Type      | Labels    | Answers                                         |
| -------------------------------------- | --------- | --------- | ----------------------------------------------- |
| `wdrg_http_requests_total`             | counter   | `outcome` | Is traffic arriving, and is it succeeding       |
| `wdrg_http_request_duration_seconds`   | histogram | `outcome` | Is the API slow, and for which class of request |
| `wdrg_errors_total`                    | counter   | `code`    | Is anything failing, and with what              |
| `wdrg_rate_limit_refusals_total`       | counter   | `class`   | Is anyone hitting a ceiling                     |
| `wdrg_rate_limit_tracked_keys`         | gauge     | —         | How much the limiter is holding                 |
| `wdrg_exports_total`                   | counter   | `format`  | How many files are being rendered               |
| `wdrg_retention_sweeps_total`          | counter   | `outcome` | Is the retention job running                    |
| `wdrg_retention_projects_purged_total` | counter   | —         | Is it actually removing anything                |
| `wdrg_retention_records_removed_total` | counter   | —         | How much it removed                             |
| `wdrg_retention_failures_total`        | counter   | —         | Is it failing on particular projects            |
| `wdrg_admin_denied_total`              | counter   | `reason`  | Is somebody trying the operator token           |
| `wdrg_process_uptime_seconds`          | gauge     | —         | Has the process restarted                       |

`outcome` is one of `ok`, `client_error`, `refused`, `server_error`. `refused` is
separated from other client errors because "somebody is hitting a ceiling" is a
different operational fact from "somebody sent a bad payload".

### Two of these did not exist until Phase 13

`wdrg_http_requests_total` and `wdrg_exports_total` were declared in Phase 12 with help
text and a type, and no code path produced a sample. A collector scraping this service
saw retention and rate-limit series and nothing at all about traffic — the first thing
anyone looks at. They are now emitted by a global interceptor and by the export service
respectively, and a test asserts both appear in a scrape.

## What is deliberately absent

**Per-route series.** A counter or histogram labelled by route is a hundred and thirty
series before status codes multiply it, and no operational question needs that
resolution. "Are requests failing" and "is the API slow" are answered by outcome class;
_which_ operation matters is answered by the audit trail, which records it precisely.

**Any label identifying a project or session.** A metric is retained far longer than an
audit event and is often visible more widely. Labels come from closed sets only — a
class, a format, an outcome, an error code — so cardinality is bounded by the code
rather than by traffic.

**Alerting.** The collector owns this. A threshold written here would be one nobody can
tune without a release.

**Tracing.** No spans, no propagation. A modular monolith with one database has a call
graph you can read in the source.

**Log shipping or aggregation.** Logs are structured JSON on stdout with redaction
already applied; where they go is a deployment decision.

## Counters are per process

They reset when the API restarts, and behind several instances each reports its own.
This is normal for counters — a collector computes rates across a reset and sums across
instances — but it matters for the operator surface: `rateLimit.refusals` and
`retention.lastSweep` in `GET /admin/status` describe _this_ instance since _this_
start, and the status response's documentation says so.

## Histogram shape

Buckets are fixed at `0.05, 0.1, 0.25, 0.5, 1, 5, 10` seconds. Seven boundaries cover
the range that tells you something: under 50ms is a read, over five seconds is a model
run or a large render, and the interesting movement is in between.

`_bucket` counts are cumulative and the `+Inf` bucket equals `_count`, which a collector
checks. `HELP` and `TYPE` are emitted once per metric name — a repeated `TYPE` line makes
a collector reject the **entire scrape**, so one malformed histogram would take every
other metric with it. Both properties are asserted by tests, because the first
implementation of the renderer got the second one wrong.

## Health, which is separate

`GET /api/health/live` — the process is up.
`GET /api/health/ready` — it can serve traffic: MongoDB reachable, process heap inside
its threshold, and the malware scanner reachable where one is configured.

Readiness is what an orchestrator or load balancer polls, so it deliberately reports
only what makes a request servable. Whether the retention sweep ran, or whether the
queue is backed up, is an operator's question rather than a routing decision — those are
on the operator surface, not here.

## Operational visibility beyond metrics

- **`GET /admin/status`** — project counts by status, retention configuration and last
  sweep, rate-limit state and refusals by class, active storage and scanner adapters.
- **`GET /admin/queue`** — depth by job state, the age of the oldest queued and oldest
  claimed job, the reclaim window, and a `stalled` flag when a claimed job has outlived
  it. This is the failure this system has that nothing surfaced before: an upload
  succeeds, the worker that claimed the job dies, and the only signal was a user saying
  it had been like that for an hour.
- **`GET /admin/projects` and `/admin/projects/:id`** — metadata and counts for support
  work. Never content.
- **`GET /admin/audit`** — recent events, filtered.
- **`GET /admin/config`** — the configuration this process resolved, allow-listed, with
  secrets reduced to whether they are set.

All of it is behind the operator token — see
[operator-surface.md](operator-surface.md).

## The console

`/admin` in the web application renders status, project search, queue state and recent
audit events. The token is entered per session and held in memory for the life of the
tab: not `localStorage`, which survives the tab and is readable by any script that ever
runs on the origin, and not a cookie, which would be attached to requests that do not
need it.

Nothing polls. A dashboard that refreshed itself every few seconds would spend the
operator's own rate-limit budget on being open, and these questions are asked
deliberately rather than watched.
