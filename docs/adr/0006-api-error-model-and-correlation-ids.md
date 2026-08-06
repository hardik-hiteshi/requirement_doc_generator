# ADR-0006: Single API error envelope with correlation ids

## Status

Accepted (Phase 1)

## Context

The application is public and unauthenticated. Anyone can send it anything, and
anyone can read what it sends back. Two consequences follow:

1. **Error responses are an attack surface.** A stack trace, a MongoDB driver
   message, a file path or an AI provider's response leaks infrastructure detail
   to an anonymous caller. NestJS's default 500 body is generic, but a
   hand-thrown `HttpException` carrying an internal message is not, and neither
   is a library exception that escapes.
2. **Support has no session to look up.** With no accounts, a user reporting "it
   failed" cannot be identified from a user id. Something in the response has to
   tie back to the logs.

The failure modes to cover are also broad — unsupported files, OCR failures,
context overflow, provider timeouts, invalid AI JSON, storage failures, expired
projects — and each needs to be distinguishable by the client without parsing
prose.

## Decision

**One error envelope for every non-2xx response**, defined once in
`@wdrg/contracts` and produced by a single global exception filter:

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED", // stable, machine-readable
    "message": "The submitted data is invalid.", // safe, user-facing
    "status": 422,
    "correlationId": "01HZX9...", // matches the x-correlation-id header
    "timestamp": "2026-08-03T10:00:00.000Z",
    "path": "/api/v1/projects",
    "details": [
      // present for validation failures
      {
        "path": "projectName",
        "message": "Project name is required.",
        "rule": "required",
      },
    ],
  },
}
```

Supporting rules:

- **The filter catches everything** (`@Catch()` with no argument). Nothing
  reaches the client unmapped.
- **5xx messages are always the generic default**, regardless of what the
  underlying exception said. The real message, the stack and the cause go to the
  log at `error` level. 4xx keeps its specific message — it is the caller's
  problem to fix — and is logged at `warn` without a stack.
- **Codes are a closed set** with a canonical HTTP status and a default safe
  message per code, so a handler cannot invent one.
- **Every request gets a correlation id**, generated at the edge or adopted from
  a caller-supplied `x-request-id`/`x-correlation-id`. It is echoed in the
  response header, embedded in the error body, and attached to every structured
  log line for that request.
- **A caller-supplied id is validated before it is trusted.** Length-bounded,
  restricted character set, and rejected outright if it contains a control
  character — an unvalidated header is a log-injection vector, and sanitising
  rather than rejecting would silently accept a mangled id and hide the attempt.

The one deliberate exception is the readiness probe, which returns Terminus's
per-indicator report. An operator needs to know _which_ dependency is down; the
generic envelope would erase that. The controller returns it explicitly rather
than letting the filter flatten it.

## Consequences

- A user can quote the correlation id from an error message and an operator can
  find the exact request. This is the only viable support path for an
  accountless product.
- Clients branch on `code` rather than on status numbers or message text. The
  web client's `ApiClientError` normalises transport failures into the same
  shape, so UI code has one thing to handle.
- Adding a failure mode means adding a code to the shared contract, which makes
  it visible to both sides and to review.
- The envelope is verified by tests on both sides: the API asserts that responses
  satisfy the schema, and a test specifically asserts that a leaky exception
  message never reaches the body.
- Structured logs carry request headers, so the logger redacts `authorization`,
  `cookie`, `x-api-key` and `set-cookie` centrally. A redaction list that misses
  something is a visible gap; a call site that forgets is a silent leak.

## Alternatives considered

**RFC 7807 `application/problem+json`.** A reasonable standard. Rejected because
its `type` URI indirection buys nothing here and its field names (`title`,
`detail`) map awkwardly onto a stable machine code plus field-level details. The
envelope above is the same idea with fields this product actually uses.

**Let NestJS's default exception handling stand.** Rejected: no correlation id,
no stable codes, and a hand-thrown exception's message reaches the client
verbatim.

**Return the correlation id only in the header.** Rejected: users copy the
visible error text, not response headers. It needs to be in the body to reach
support.
