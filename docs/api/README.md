# API conventions

> Phase 1 exposes health probes and the OpenAPI document. The conventions below
> govern every endpoint added later.

## Base path and versioning

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| Prefix          | `/api`                                                          |
| Versioning      | URI (`/api/v1/...`)                                             |
| Current version | `1`                                                             |
| OpenAPI UI      | `/api/docs` (configurable; disable in production if not public) |
| OpenAPI JSON    | `/api/docs-json`                                                |

Operational endpoints are **version-neutral** — `/api/health/live` and
`/api/health/ready` carry no version segment. Probes, load balancers and uptime
monitors must not need reconfiguring when the business API moves to v2.

A new major version is introduced only for a breaking change: removing a field,
narrowing a type, changing a status code, or altering the meaning of an existing
field. Adding an optional field is not breaking and does not warrant one.

## Health probes

**`GET /api/health/live`** — is the process alive? Checks no external dependency
by design: a database outage must not cause an orchestrator to restart an
otherwise healthy instance.

```json
{
  "status": "ok",
  "service": "wdrg-api",
  "version": "0.1.0",
  "uptimeSeconds": 128,
  "timestamp": "2026-08-03T10:00:00.000Z"
}
```

**`GET /api/health/ready`** — can this instance serve traffic? Checks MongoDB and
process heap. Returns `200` when everything is up, `503` otherwise, with the
failing indicator named:

```json
{
  "status": "error",
  "info": { "memory_heap": { "status": "up" } },
  "error": { "mongodb": { "status": "down", "message": "connection refused" } },
  "details": {
    "memory_heap": { "status": "up" },
    "mongodb": { "status": "down", "message": "connection refused" }
  }
}
```

This is the one endpoint that does not use the standard error envelope: an
operator needs to know _which_ dependency failed, and the envelope would erase
that. The decision is recorded in [ADR-0006](../adr/0006-api-error-model-and-correlation-ids.md).

## Error responses

Every other non-2xx response uses one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The submitted data is invalid.",
    "status": 422,
    "correlationId": "01HZX9K3M4P5Q6R7S8T9V0W1X2",
    "timestamp": "2026-08-03T10:00:00.000Z",
    "path": "/api/v1/projects",
    "details": [
      {
        "path": "projectName",
        "message": "Project name is required.",
        "rule": "required"
      }
    ]
  }
}
```

| Field           | Notes                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `code`          | Stable machine-readable identifier. **Branch on this**, not on status or message text.                           |
| `message`       | Safe to display. For 5xx it is always generic — the real cause is in the logs.                                   |
| `status`        | Mirrors the HTTP status.                                                                                         |
| `correlationId` | Matches the `x-correlation-id` response header and every log line for the request. Quote it in support requests. |
| `path`          | The request path that failed.                                                                                    |
| `details`       | Field-level problems. Present for validation failures; `path` maps to the submitted field.                       |

### Codes

| Code                  | Status | Meaning                                                     |
| --------------------- | ------ | ----------------------------------------------------------- |
| `VALIDATION_FAILED`   | 422    | Payload failed schema validation. See `details`.            |
| `BAD_REQUEST`         | 400    | Malformed request that is not a field-level failure.        |
| `UNAUTHORIZED`        | 401    | No project session, or it was rejected.                     |
| `FORBIDDEN`           | 403    | Authenticated but not permitted.                            |
| `NOT_FOUND`           | 404    | No such resource, or the caller may not know there is one.  |
| `CONFLICT`            | 409    | Conflicts with current state — version mismatch, duplicate. |
| `PAYLOAD_TOO_LARGE`   | 413    | Exceeded a configured size limit.                           |
| `RATE_LIMITED`        | 429    | Exceeded a rate or usage quota.                             |
| `SERVICE_UNAVAILABLE` | 503    | A dependency is unavailable.                                |
| `INTERNAL_ERROR`      | 500    | Unexpected. Message is always generic.                      |

The set is defined in `@wdrg/contracts` and both applications import it, so a new
code is visible to the client the moment it is added.

## Correlation ids

Every response carries `x-correlation-id`.

- Supply your own via `x-request-id` or `x-correlation-id` and it is adopted, so
  a trace spans your gateway and this API.
- A supplied value is validated first: max 128 characters, `[A-Za-z0-9._:-]`
  only, and rejected outright if it contains a control character. An
  unvalidated header is a log-injection vector.
- If none is supplied, or the supplied one is rejected, the API generates a UUID.

## Phase 2 endpoints

All project routes are under `/api/v1/projects`. The three access routes need no
session; everything under `/current` requires one.

| Method | Path                                          | Session | Purpose                                                          |
| ------ | --------------------------------------------- | ------- | ---------------------------------------------------------------- |
| POST   | `/api/v1/projects`                            | no      | Create an anonymous project. Shows the recovery secret **once**. |
| POST   | `/api/v1/projects/session`                    | no      | Exchange a recovery secret for a session cookie.                 |
| DELETE | `/api/v1/projects/session`                    | no      | End the session. The project is untouched.                       |
| GET    | `/api/v1/projects/current`                    | yes     | Read the project the session is bound to.                        |
| PUT    | `/api/v1/projects/current/details`            | yes     | Name, client, reference, description, project types.             |
| PUT    | `/api/v1/projects/current/timeline`           | yes     | The mandatory delivery timeline.                                 |
| PUT    | `/api/v1/projects/current/start-date`         | yes     | Start-date mode, with a date only where the mode has one.        |
| PUT    | `/api/v1/projects/current/team-capacity`      | yes     | Optional team and capacity inputs.                               |
| PUT    | `/api/v1/projects/current/output-preferences` | yes     | Export formats per document.                                     |
| DELETE | `/api/v1/projects/current`                    | yes     | Delete, confirmed by typed project name.                         |

**The project is always taken from the session**, never from a path or body
parameter. There is no request in which a caller can name a project it has not
authenticated for, so the "forgot the ownership check" class of bug cannot occur.

### Recovery-secret semantics

`POST /api/v1/projects` is the only response that ever contains the raw secret —
the server keeps a salted hash, so it cannot be shown again. The **link is not
single-use**:

| Behaviour                                     | Answer                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| Exchange the same secret more than once       | Yes, without limit, from any device                          |
| Concurrent project sessions                   | Yes — each exchange adds one, none are displaced             |
| Credential invalidated by                     | Project deletion or expiry, and nothing else                 |
| Who may use the link                          | Anyone holding it, with full read, edit and delete rights    |
| Effect of deletion or expiry on open sessions | All fail immediately; every request re-checks project status |

Rotating `PROJECT_SESSION_SECRET` invalidates every live **session** but leaves
the recovery credential intact.

## Phase 3 endpoints

Requirement sources for the session's project. Every route is under
`/api/v1/projects/current/sources`, so a `sourceId` in a path is scoped by the
session: an id belonging to another project answers **404**, identically to one
that never existed.

| Method | Path                                      | Purpose                                            |
| ------ | ----------------------------------------- | -------------------------------------------------- |
| GET    | `/sources`                                | Every source, with storage usage against the quota |
| POST   | `/sources/text`                           | Add a pasted-text source                           |
| POST   | `/sources/files`                          | Multipart upload; one outcome per file             |
| GET    | `/sources/{sourceId}`                     | One source, with effective and original content    |
| PUT    | `/sources/{sourceId}/text`                | Edit a pasted-text source                          |
| GET    | `/sources/{sourceId}/content`             | Extracted content                                  |
| PUT    | `/sources/{sourceId}/content/corrections` | Save corrections as a new revision                 |
| POST   | `/sources/{sourceId}/content/restore`     | Point the effective content back at revision 0     |
| POST   | `/sources/{sourceId}/review`              | Mark reviewed                                      |
| POST   | `/sources/{sourceId}/retry`               | Retry a failed source                              |
| DELETE | `/sources/{sourceId}`                     | Soft-delete, and remove the stored file            |
| GET    | `/sources/{sourceId}/download`            | Stream the original file                           |

### Uploads

`POST /sources/files` takes `multipart/form-data` with a repeated `files` field
and returns **one outcome per file**. A rejected file never fails the batch:

```json
{
  "outcomes": [
    {
      "originalFilename": "brief.pdf",
      "accepted": true,
      "source": { "...": "..." }
    },
    {
      "originalFilename": "invoice.pdf",
      "accepted": false,
      "errorCode": "SIGNATURE_MISMATCH",
      "errorMessage": "The file's contents do not match its extension. It may be renamed, damaged, or not the format it claims to be."
    }
  ]
}
```

Every rejection carries a stable `errorCode` and a message that names the problem
and, where there is one, the fix. Technical detail — which signature was found,
which limit was exceeded — goes to the structured log under the request's
correlation id, never to the caller.

### Downloads

The stored object key is **never** returned by any endpoint. It is an internal
address, not a credential, and exposing it would create a second way to name a
file. Downloads stream through the route above, which checks the session first,
and are sent with `Content-Disposition: attachment` and `X-Content-Type-Options:
nosniff` so an uploaded file can never render inside this origin.

### Effective versus original content

`effectiveContent` is the latest correction if there is one, otherwise the
original extraction. `originalContent` is always revision 0. The field is named
`effectiveContent` rather than `content` on purpose: a caller reaching for "the
content" must not silently receive the unreviewed original.

### Cookies

| Cookie                 | Flags                                                      | Purpose                                                               |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `wdrg_project_session` | `HttpOnly`, `SameSite=Lax`, `Secure` in production         | Signed session. Script must never read it.                            |
| `wdrg_csrf`            | `SameSite=Lax`, `Secure` in production, **not** `HttpOnly` | Double-submit CSRF token. Readable by design — that is the mechanism. |

`SameSite=Lax` rather than `Strict`: a recovery link is a top-level navigation
from wherever the user saved it, and `Strict` would drop the cookie on that first
navigation.

### CSRF

Every `POST`, `PUT`, `PATCH` and `DELETE` requires the `x-csrf-token` header to
match the `wdrg_csrf` cookie, and any `Origin` header present must be in the
allow-list. Reads require neither.

### Optimistic concurrency

Every update carries the `version` last read. A mismatch returns `409 CONFLICT`
with `error.details[0].rule = "version_conflict"`; reload before saving again.

### Access failures are uniform

Unknown project, wrong secret, expired and deleted all return the same `401` with
the same message. Distinguishing them would let a caller confirm which project
ids exist. The real reason is in the audit trail.

## Request conventions

|                |                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ |
| Content type   | `application/json` for request and response bodies                                   |
| Body limit     | Configurable (`REQUEST_BODY_LIMIT_BYTES`, default 1 MiB)                             |
| Unknown fields | Silently stripped by validation, never persisted                                     |
| Credentials    | Project access travels in an HttpOnly cookie — clients send `credentials: 'include'` |
| Timestamps     | ISO-8601 UTC strings                                                                 |

## Client usage

The web application calls the API through `apps/web/src/lib/api-client.ts`, which
normalises every failure — HTTP error, network drop, unparseable body — into a
single `ApiClientError` carrying `code`, `correlationId`, `details` and an
`isRetryable` flag. UI code branches on that rather than re-deriving meaning from
a status number at each call site.
