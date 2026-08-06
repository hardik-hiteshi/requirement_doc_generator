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
