# Threat model: anonymous project access

> Scope: the Phase 2 access model. Updated as each later phase adds surface — last
> reviewed after Phase 14, which shipped the deployable images and the backup
> procedure, and so answered where encryption at rest belongs. Phase 12 closed the
> rate-limiting and retention gaps this document had recorded as open.

## What we are protecting

A project holds a client's requirements, commercial estimates and delivery
plans. It is commercially sensitive but not regulated data. There are **no
accounts**: possession of the recovery link _is_ authorisation.

## The two values, and why they are separate

| Value                       | Entropy  | Job               | Where it lives                                                  |
| --------------------------- | -------- | ----------------- | --------------------------------------------------------------- |
| Public project id (`prj_…`) | 128 bits | Names the project | URLs, logs, error envelopes, audit records                      |
| Recovery secret             | 256 bits | Authorises access | The user's saved link, and a salted scrypt hash in the database |

The recovery secret is **displayed once** and **usable indefinitely**. Those are
separate properties, and the threat picture depends on both: the first is why a
lost link is fatal, the second is why a leaked link is permanent. The exact
semantics are in ADR-0010; the consequences are the accepted risks below.

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
3. **A leaked link is permanent access.** The credential is reusable and cannot
   be rotated, so a link that reaches the wrong person keeps working until the
   project is deleted or expires. Deleting and recreating is the only remedy.
4. **A shared link cannot be revoked** in Phase 2. Regenerating a recovery secret
   is deliberately not implemented: doing it safely needs a way to prove you are
   the legitimate holder, which an account-less model does not provide. Deleting
   the project and starting again is the honest answer, and is what the UI
   offers.
5. **Sessions cannot be enumerated or revoked individually.** Several may exist
   at once — one per exchange — and there is no server-side list of them. What
   ends them all at once is the project being deleted or expiring, or
   `PROJECT_SESSION_SECRET` being rotated.
6. **Rate limiting arrived in Phase 12.** When this was written, brute force was
   bounded only by the 256-bit secret — infeasible, but unmetered. Recovery
   attempts now draw on their own address-keyed budget, deliberately the tightest
   of the seven classes, so guessing is bounded as well as infeasible. The limiter
   sits ahead of the session guard rather than behind it, so a flood is refused
   before any cookie is verified — see
   [request ceilings](../operations/rate-limiting.md).

## Phase 3: uploaded files

Requirement documents are the most sensitive thing this application holds — they
are the client's own material, not metadata about it.

| Asset             | Threat                                | Control                                                                                                                                                                         |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uploaded file     | Read by another project               | Every query is scoped by `projectId`, and a source id from elsewhere answers 404 — identical to one that never existed                                                          |
| Uploaded file     | Reached without a session             | Nothing is web-served. The storage root is outside every static directory, and the only route to a file checks the session first                                                |
| Uploaded file     | Path traversal                        | Paths are built only from an application-minted project id and object id. A client filename never participates in a path                                                        |
| Uploaded file     | Rendered in our origin                | `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` on every download, so an HTML or SVG upload cannot become stored XSS                                    |
| Uploaded file     | Disguised executable                  | Extension, declared MIME and leading bytes must all agree. A recognised-but-wrong format is named in the rejection                                                              |
| Parser            | Zip bomb                              | The ZIP directory's declared sizes are summed without inflating anything, and the compression ratio is bounded                                                                  |
| Parser            | XXE                                   | Libraries do not resolve external entities; an entity-declaration check is a second line                                                                                        |
| Parser            | Formula execution                     | Formulas are read as text, never evaluated, in both CSV and XLSX                                                                                                                |
| Parser            | Runaway resource use                  | Wall-clock timeout per extraction, plus block, row and page ceilings                                                                                                            |
| Storage           | Unbounded growth                      | Per-file, per-project and file-count quotas, enforced per file within a batch                                                                                                   |
| Extracted content | Prompt injection into a later phase   | Content is typed as `EVIDENCE` and never placed where instructions are read. Instruction-shaped text is flagged for the user and kept verbatim — see the ingestion architecture |
| Audit trail       | Requirement content leaking into it   | Audit metadata records counts, ids and codes. No block text, no filename content, no pasted text                                                                                |
| Logs              | Requirement content leaking into them | Failures log a code and an operator detail. The browser suite asserts a recovery secret never reaches a log; content is held to the same rule by the audit sanitiser            |

### Accepted risks, Phase 3

1. **No malware scanning ships.** `MALWARE_SCANNER=none` records `NOT_SCANNED` —
   deliberately not `CLEAN` — and keeps the file. A deployment that cannot accept
   that sets `reject`, which refuses every upload until a scanner adapter exists.
   Files are never executed, never served inline, and never rendered in our
   origin, which bounds what an infected upload could do here; it does not bound
   what it could do to whoever downloads it.
2. **Files are stored unencrypted at rest**, beyond whatever the underlying disk
   provides. Encryption at rest belongs to the deployment, not to the application —
   and after Phase 14 that is stated where an operator will meet it rather than left
   to a later phase: the backup archive contains client documents and
   [backup and restore](../operations/backup-and-restore.md#encryption-is-your-job-deliberately)
   says plainly that encrypting it is your job, with the reason a script that invented
   a key would be worse than none.
3. **A deleted source's file is removed immediately, but its extracted content
   revisions are not.** The record is soft-deleted, and its content is removed with
   the rest of the project's when the retention job purges it — see
   [retention](../operations/retention.md). Retention is off by default, so a
   deployment that has not enabled it keeps that content indefinitely.
4. **Extraction runs in the API process.** A pathological file consumes worker
   time that HTTP requests would otherwise have. Bounded by the timeout and by
   one-job-at-a-time, not eliminated.

## Phase 8: what a generated commercial document can do

Documents 3 to 5 add a class of exposure that has nothing to do with access control:
the application produces text somebody signs.

**An invented commitment.** An acceptance condition stating a response time, an
availability figure or a compliance standard the requirements never mentioned is a
contractual obligation created by a text generator. Controlled by
`UNSTATED_THRESHOLD_PATTERNS`, which compares any figure in a criterion against the
approved requirement text, and blocks — not warns — when it appears only in the
criterion.

**An invented legal term.** A statement of work reading complete, with governing law,
a warranty and payment terms, would be signed before anybody noticed nothing had
created those obligations. Controlled by `PROHIBITED_LEGAL_PATTERNS` as a BLOCKING
check, with the missing terms written into the document as _outstanding_ so their
absence is visible rather than silent.

**A laundered gap.** A missing answer restated as an assumption reads as agreed. The
control is provenance: an assumption needs a person behind it, a model cannot express
one (`assumptionCandidateSchema` has no status or provenance field), and
`openQuestionsTreatedAsAssumptions` blocks when a confirmed assumption restates an
unanswered clarification. ADR-0036.

**Internal methodology disclosure.** Whether to tell a client the estimate was
AI-assisted is a commercial decision belonging to the sender, not to whichever word
survived a prompt. `INTERNAL_METHODOLOGY_PATTERNS` blocks model names, "AI-assisted
development", productivity multipliers and confidence figures from every client-facing
document.

**A staffing promise.** "Two backend developers will be assigned" tells a client
something untrue about how their project is resourced. `STAFFING_CLAIM_PATTERNS`
blocks it; responsibilities are safe and are what the document states instead.

Correction instructions remain untrusted evidence throughout, on the Phase 7 footing:
they travel in the evidence channel, never as system instruction, and the defences
that matter are structural — a citation check, a locked-stack comparison, a schema
with no field for hours, a status only a person can set.

## Out of scope for Phase 2

This list is the record as it stood when the Phase 2 access model was written, and is
kept as written: malware scanning and upload validation (Phase 3, no uploads exist
yet); CAPTCHA and abuse quotas (Phase 12); a web-application CSP (Phase 12); retention
and physical deletion of `DELETION_PENDING` records (Phase 12).

**Since then:** upload validation and malware scanning shipped in Phase 3, and abuse
quotas, retention and the physical removal of `DELETION_PENDING` content shipped in
Phase 12. A web-application CSP and CAPTCHA remain unimplemented and are not assigned
to a phase.

## Residual questions for later phases

- **Retention — answered in Phase 12.** `DELETION_PENDING` is terminal for the user,
  and the record now moves to `DELETED` once a configurable grace window has passed.
  The transition removes the project's content from every collection that holds it,
  and its objects in storage; the project record and its audit trail survive, because
  a deletion that cannot be accounted for afterwards is not a better deletion. See
  [retention](../operations/retention.md).
- **Session revocation at scale.** Rotating `PROJECT_SESSION_SECRET` invalidates
  every session at once. If per-project revocation is ever needed, the stateless
  session design would have to change — see ADR-0010.
