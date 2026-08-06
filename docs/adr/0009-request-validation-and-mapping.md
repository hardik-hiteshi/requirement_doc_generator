# ADR-0009: Request validation and explicit domain mapping

## Status

Accepted (Phase 1)

## Context

The public API is unauthenticated: any caller can post any JSON. The failure
mode to design against is **over-posting** — a client sending fields it was never
offered, which then reach persistence and change state the client should not
control (`isApproved`, `status`, `ownerId`).

An earlier draft of this project's documentation claimed that schema validation
made mass assignment "impossible by construction". That claim was wrong, in two
distinct ways, and correcting it is the reason this ADR exists.

**First, stripping is not rejection, and neither is complete.** Zod strips
undeclared keys by default, so the parsed value is clean. But `.strict()` — the
opt-in that turns stripping into an error — applies to a single object level. It
does not reach through `.optional()`, `.nullable()` or array wrappers, so a
nested unexpected property passes unnoticed. Verified against Zod 4.4.3:

```ts
const schema = z.object({ t: z.object({ d: z.number() }).optional() }).strict();
schema.parse({ t: { d: 1, isLocked: true } }); // accepted; isLocked silently dropped
```

**Second, `.strict()` misses `__proto__`.** `JSON.parse` creates `__proto__` as
an own enumerable property, and Zod does not report it as an unknown key:

```ts
z
  .object({ a: z.string() })
  .strict()
  .safeParse(JSON.parse('{"a":"x","__proto__":{"admin":true}}')).success; // true
```

**Third, and most importantly, no amount of parsing prevents mass assignment on
its own.** Validation cannot know whether a _declared_ field should be
client-settable. A schema that declares `status` accepts `status`. What actually
causes mass assignment is passing a validated body straight into a repository —
and that happens after validation has already succeeded.

## Decision

Three layers, each of which a field must survive to reach the database.

**1. Reject undeclared properties by default.** `ZodValidationPipe` defaults to
`unknownKeys: 'reject'`. A client sending a field the server does not know about
is either out of date or probing; both are worth surfacing. `strip` remains
available for endpoints that must tolerate version skew, and every use must carry
a comment justifying it.

Detection compares the parsed output against the input and reports any key that
did not survive, at any depth. This is used instead of walking the schema and
applying `.strict()` because of the wrapper limitation above: the diff is
schema-agnostic, reaches arbitrary nesting, and depends on no Zod internals.

**2. Refuse prototype-polluting keys outright.** `__proto__`, `constructor` and
`prototype` are rejected anywhere in the payload under _either_ policy. There is
no legitimate request that carries one, and stripping silently would hide a
deliberate probe.

**3. Map explicitly to a domain type.** `createRequestMapper(schema, map)` pairs a
schema with a mapping function and returns a pipe whose output type is the
**domain** type. A controller therefore has no request-shaped value in scope to
forward. Domain-owned fields are set by the mapping, never taken from input:

```ts
const createProject = createRequestMapper(createProjectSchema, (input) => ({
  name: input.projectName.trim(),
  clientName: input.clientName ?? null,
  status: 'draft' as const, // owned by the domain, never from the client
}));
```

The rule this encodes: **a repository never accepts a request-shaped type.** The
chain is `request → validated input → domain object → persistence document`, and
each arrow requires a field to be named to survive.

## Consequences

- Over-posting requires a mistake at two independent layers rather than one.
- Rejecting rather than stripping turns a silent drop into a `422` naming the
  offending path, so an out-of-date client is diagnosable instead of mysteriously
  losing data.
- The tests are the specification: `zod-validation.pipe.spec.ts` covers nested
  unexpected properties and each prototype-polluting key;
  `request-mapper.spec.ts` covers a payload attempting to set a domain-owned
  field.
- Cost: a mapping function per endpoint. That is the point — the alternative is
  the implicit forwarding this ADR exists to prevent.
- Caveat: a schema whose `.transform()` deliberately reshapes the payload looks
  like it dropped unknown keys. Such endpoints use `strip` and do their reshaping
  in the mapping layer, where it is visible.
- Phase 1 exposes no request bodies, so nothing uses this yet. It is in place
  before the first endpoint precisely so the first endpoint does not have to
  invent it.

## Alternatives considered

**Rely on Zod stripping alone.** Rejected — that is the claim this ADR corrects.
It leaves declared-but-privileged fields entirely unguarded.

**Schema-walking with recursive `.strict()`.** Implemented first, then removed.
It required reading Zod's internal `def.type` / `def.shape` and rebuilding each
wrapper type, which is brittle across minor versions. The output diff achieves
the same result with no coupling to internals.

**A denylist of dangerous field names.** Rejected: denylists fail as soon as a
new privileged field is added and nobody updates the list. The mapping approach
fails safe — a field nobody explicitly mapped simply does not arrive.

**Trust the ORM.** Rejected: Mongoose strips paths not in the schema, but the
persistence schema is not the authorization boundary. It will legitimately
contain `status`; the question is who may set it.
