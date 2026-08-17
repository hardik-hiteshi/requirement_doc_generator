# Request ceilings

Some requests cost far more than others. Reading a project panel is a database lookup;
generating a document runs a language model, rendering an export produces a file, and
ingesting an upload scans and extracts it. A single ceiling across all of them would have
to be set high enough for ordinary browsing, which would leave the expensive paths
effectively unlimited.

So requests are classified, and each class carries its own budget.

| Class       | Covers                                                  | Default         |
| ----------- | ------------------------------------------------------- | --------------- |
| `default`   | Reads, small writes, progress polling                   | 600 / minute    |
| `mutation`  | State-changing requests not otherwise classified        | 120 / minute    |
| `expensive` | Model runs, document generation, validation, estimation | 10 / 5 minutes  |
| `export`    | Rendering and downloading a document                    | 30 / 5 minutes  |
| `upload`    | File ingestion                                          | 30 / hour       |
| `access`    | Recovering a project with its secret                    | 10 / 15 minutes |
| `create`    | Creating a project                                      | 30 / hour       |

These are protective ceilings, not quotas. The interface never approaches one in normal
use; a caller that does is a script, a stuck retry loop, or abuse.

## What a caller sees

Every response carries `x-ratelimit-limit` and `x-ratelimit-remaining` for the class it
consumed, so a client can slow down before it is refused. A refusal is `429` with
`retry-after` in seconds and the standard error envelope. The body names no class and no
number: that combination is a map of the ceilings.

## Which class a route uses

Unannotated routes are classified by method — a read draws on `default`, a write on
`mutation` — so a new endpoint is protected the moment it exists rather than when somebody
remembers to annotate it. Routes whose cost is invisible from the verb are declared
explicitly with `@RateLimit('expensive')` and friends.

## How a caller is identified

By session for every class except `access`, so one project cannot spend another's budget
and a shared office address is not one shared ceiling.

`access` and `create` are keyed by network address, because both happen _before_ there is a
session — a session key would be either absent or attacker-chosen.

They are separate classes because they are different risks that share a controller.
Guessing a recovery secret attacks one project's confidentiality: ten attempts per quarter
hour makes it hopeless while leaving somebody mistyping their own perfectly able to get in.
Creating projects in bulk attacks disk, and an agency starting a dozen projects in an
afternoon from one office is ordinary work — putting that on the credential-guessing budget
would have locked them out after ten.

The limiter runs **ahead of session verification**, deliberately: a request that will be
refused for cost should be refused before anything expensive happens, and a flood of
unauthenticated requests must not become a flood of audit writes. One consequence is that
a `RATE_LIMIT_EXCEEDED` audit event names the class and the method but not the project —
the only identity available at that point is one the caller supplied, and an
attacker-chosen value does not belong in the audit trail.

## The limitation you need to know about

**Counters are held in the API process.** Behind a load balancer with _N_ instances, the
effective ceiling is _N_ times the configured one.

This is a deliberate trade for the deployment this system targets — a single API
container. A shared store would give one global ceiling, and there are two ways to get
one:

- **Redis.** Purpose-built and fast, but a fourth service to run, secure, monitor and back
  up in order to coordinate a single participant, plus a new failure mode to decide about
  (if the limiter is unreachable, does the API fail open or closed?).
- **MongoDB counters.** No new service, but a database round-trip added to every request
  across all 132 routes — including cheap reads and the workspace's progress polling.

Neither cost is worth paying for one instance. `RateLimitStore` exists as a class with a
single `consume` method precisely so a shared implementation can replace it without the
guard changing. **If you run more than one API instance, either accept the multiplied
ceiling — divide the configured limits by the instance count to compensate — or implement
a shared store behind that method.**

## Configuration

| Variable                                   | Default   | Meaning                                         |
| ------------------------------------------ | --------- | ----------------------------------------------- |
| `RATE_LIMIT_ENABLED`                       | `true`    | Master switch. Production refuses `false`.      |
| `RATE_LIMIT_DEFAULT` / `_WINDOW_SECONDS`   | 600 / 60  | The `default` class                             |
| `RATE_LIMIT_MUTATION` / `_WINDOW_SECONDS`  | 120 / 60  | The `mutation` class                            |
| `RATE_LIMIT_EXPENSIVE` / `_WINDOW_SECONDS` | 10 / 300  | The `expensive` class                           |
| `RATE_LIMIT_EXPORT` / `_WINDOW_SECONDS`    | 30 / 300  | The `export` class                              |
| `RATE_LIMIT_UPLOAD` / `_WINDOW_SECONDS`    | 30 / 3600 | The `upload` class                              |
| `RATE_LIMIT_ACCESS` / `_WINDOW_SECONDS`    | 10 / 900  | The `access` class                              |
| `RATE_LIMIT_CREATE` / `_WINDOW_SECONDS`    | 30 / 3600 | The `create` class                              |
| `RATE_LIMIT_MAX_KEYS`                      | 50000     | Counter keys held before the oldest are dropped |

`RATE_LIMIT_MAX_KEYS` bounds memory rather than expressing a policy: without it, a flood
from many addresses would grow the map until the process died, which is the outage the
limiter exists to prevent.

## Windows are fixed, not sliding

A fixed window is a counter and an expiry. It admits a burst at a window boundary — up to
twice the budget across two adjacent windows — which matters for a limiter defending a
shared quota and does not matter for one defending a single machine's capacity. A sliding
log would cost memory proportional to traffic to remove a boundary effect nobody here can
exploit usefully.

A refused caller that keeps trying does not push its own window forward. A limiter that
slid the window on every refusal could lock somebody out indefinitely because of a retry
loop they cannot see.
