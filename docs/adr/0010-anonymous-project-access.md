# ADR-0010: Anonymous project access with a split identifier and stateless session

## Status

Accepted (Phase 2)

## Context

The public workspace must work with no account. A user creates a project, leaves,
and comes back — possibly days later, possibly on another device — and must reach
exactly their project and nobody else's.

The obvious design is a single unguessable URL: one long random value that both
names the project and grants access. It is also wrong in a specific way: that
value then appears in the address bar, in server access logs, in proxy logs, in
`Referer` headers, and in any error message that quotes the request path. A
credential that is also an identifier cannot be handled safely, because the two
have opposite requirements — an identifier wants to be visible, a credential
wants to be secret.

## Decision

**Two values with separate jobs.**

- A **public project id** (`prj_` + 26 Crockford base32 characters, 128 bits)
  names the project. It is unguessable, so it cannot be enumerated, but it grants
  nothing on its own. It may appear in logs, URLs and error envelopes.
- A **recovery secret** (256 bits, base64url) authorises access. Only a salted
  scrypt hash is stored. The raw value is returned exactly once, at creation.

**The secret travels in the URL fragment**, not the query string:
`/recover#p=prj_…&s=…`. A fragment is never sent to the server, so it cannot
reach an access log, a proxy log or a `Referer` header. The client reads it,
exchanges it for a session cookie, then clears it with `history.replaceState`.

**Sessions are stateless signed cookies**, not database rows. The cookie carries
`{projectId, issuedAt, expiresAt}` with an HMAC-SHA256 signature; the signature
is verified with a timing-safe comparison _before_ the payload is parsed.

**Every failure to reach a project returns the same code and message** — unknown
project, wrong secret, expired, deleted. The real reason goes to the audit trail
and the structured logs.

## Consequences

- The identifier can be shown, logged and quoted in support conversations
  without leaking access.
- A database leak yields no working credentials.
- No session collection, no session index, no session cleanup job — for a product
  with no accounts to attach sessions to, that is a real reduction in moving
  parts.
- The usual objection to stateless sessions, that they cannot be revoked, does
  not bite here: every request loads the project and checks its status, so
  deleting or expiring a project makes outstanding cookies useless immediately.
  There is no other revocation case — no passwords, roles or accounts to change.
- Rotating `PROJECT_SESSION_SECRET` invalidates every live session at once. That
  is the emergency lever; there is no finer-grained one.
- **A lost recovery link is an unrecoverable project.** This is the direct cost of
  the design and the UI must state it plainly rather than bury it.
- **Anyone holding the link has full access.** Also stated in the UI, with an
  explicit acknowledgement required before leaving the creation screen.

## Alternatives considered

**One long unguessable URL for both naming and access.** Rejected for the
reason in the context: it makes every log line and `Referer` a credential leak.

**Secret in the query string rather than the fragment.** Rejected: query strings
are logged by essentially every server and proxy, and are sent in `Referer` on
outbound links. The fragment costs nothing and removes the whole class.

**Database-backed sessions.** Would allow per-session revocation. Rejected as
solving a problem this product does not have — there is no case where a session
must die while its project lives on. Revisit if that changes.

**Emailed magic links.** Would give recovery without storing a link, and a
revocation channel. Rejected: it requires an email address, which makes the
product no longer anonymous, and adds a delivery dependency to the critical path
of creating a project.

**Regenerating the recovery secret.** Deliberately not implemented. Rotating a
credential safely requires proving you are its legitimate holder; with no
accounts, the only proof available is the current secret — so anyone who has
leaked it can also rotate it and lock the original user out. Delete-and-recreate
is the honest option and is what the UI offers.
