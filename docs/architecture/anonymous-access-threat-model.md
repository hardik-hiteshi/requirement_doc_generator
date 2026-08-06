# Threat model: anonymous project access

> Scope: the Phase 2 access model. Updated as each later phase adds surface.

## What we are protecting

A project holds a client's requirements, commercial estimates and delivery
plans. It is commercially sensitive but not regulated data. There are **no
accounts**: possession of the recovery link _is_ authorisation.

## The two values, and why they are separate

| Value                       | Entropy  | Job               | Where it lives                                                  |
| --------------------------- | -------- | ----------------- | --------------------------------------------------------------- |
| Public project id (`prj_…`) | 128 bits | Names the project | URLs, logs, error envelopes, audit records                      |
| Recovery secret             | 256 bits | Authorises access | The user's saved link, and a salted scrypt hash in the database |

Splitting them is what allows the identifier to appear in a log or an error
message without becoming a credential. A design that used one value for both
would force every log line to be treated as secret.

## Assets and controls

| Asset           | Threat                      | Control                                                                                                                                                                                                          |
| --------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery secret | Database compromise         | Only a salted scrypt hash is stored. The raw value exists solely in the creation response.                                                                                                                       |
| Recovery secret | Leaked via URL              | Carried in the URL **fragment**, which browsers never send to a server — absent from access logs, proxy logs and `Referer`. Cleared from the address bar with `history.replaceState` immediately after exchange. |
| Recovery secret | Leaked via logs             | Never logged. The audit service redacts by key name _and_ by value shape, so a secret filed under an innocuous key is still caught.                                                                              |
| Project data    | Enumeration                 | 128-bit unguessable id; every access failure returns an identical code and message, so responses cannot confirm which ids exist.                                                                                 |
| Project data    | Cross-project access        | The project is taken from the verified session, never from the URL or body. There is no request shape in which a caller can name a project it has not authenticated for.                                         |
| Session cookie  | Theft via XSS               | `HttpOnly`, so script cannot read it. `Secure` in production.                                                                                                                                                    |
| Session cookie  | CSRF                        | `SameSite=Lax` + `Origin` validation + double-submit CSRF token, all three required for a mutation.                                                                                                              |
| Session cookie  | Forgery                     | HMAC-SHA256 signature over the payload, verified with a timing-safe comparison before the payload is parsed.                                                                                                     |
| Session cookie  | Use after deletion          | Every request re-loads the project and checks its status, so a deleted or expired project makes outstanding cookies useless immediately.                                                                         |
| Timing          | Oracle on project existence | A recovery attempt for an unknown project still performs a hash, so response time does not distinguish "no such project" from "wrong secret".                                                                    |
| Request body    | Over-posting                | Undeclared properties rejected at any depth; prototype-polluting keys refused; explicit request → domain → persistence mapping (ADR-0009).                                                                       |

## Accepted risks

These are consequences of a deliberately account-less product. They are stated
in the UI, not just here.

1. **Anyone with the recovery link has full access** — read, edit and delete.
   There is no second factor and no way to distinguish the original creator from
   anyone they forwarded the link to. The creation panel says this in full and
   requires an explicit acknowledgement before continuing.
2. **A lost link means a lost project.** Nothing can restore it, including
   support, because the server has no way to re-derive the secret.
3. **A shared link cannot be revoked** in Phase 2. Regenerating a recovery secret
   is deliberately not implemented: doing it safely needs a way to prove you are
   the legitimate holder, which an account-less model does not provide. Deleting
   the project and starting again is the honest answer, and is what the UI
   offers.
4. **No rate limiting yet.** The integration point exists (the session guard is
   the single choke point for every project operation) but limits are Phase 12.
   Until then, brute force is bounded only by the 256-bit secret — infeasible,
   but unmetered.

## Out of scope for Phase 2

Malware scanning and upload validation (Phase 3, no uploads exist yet); CAPTCHA
and abuse quotas (Phase 12); a web-application CSP (Phase 12); retention and
physical deletion of `DELETION_PENDING` records (Phase 12).

## Residual questions for later phases

- **Retention.** `DELETION_PENDING` is currently terminal for the user but the
  record persists. Phase 12 must define how long, and what the transition to
  `DELETED` physically removes versus retains for audit.
- **Session revocation at scale.** Rotating `PROJECT_SESSION_SECRET` invalidates
  every session at once. If per-project revocation is ever needed, the stateless
  session design would have to change — see ADR-0010.
