# ADR-0007: Zod as the single schema language

## Status

Accepted (Phase 1)

## Context

Validation is needed in five places, and they must agree:

1. Environment variables at startup.
2. Inbound HTTP request bodies.
3. AI responses — the hard one. Every AI task must return JSON matching a schema,
   with malformed responses rejected and repaired rather than persisted.
4. Structured document content before export.
5. Client-side form validation.

Using a different tool at each layer (class-validator for HTTP, JSON Schema for
AI, Yup for forms) means the same rule is written three times and drifts.

## Decision

**Zod is the single schema language**, everywhere, at every layer.

- Schemas are declared once and the TypeScript type is inferred with
  `z.infer<>`. A type and its validator cannot disagree, because one is derived
  from the other.
- Environment parsing uses Zod via `@wdrg/config`, which aggregates every
  failure into one error rather than failing on the first.
- HTTP validation uses `ZodValidationPipe`, which rejects undeclared properties
  at any depth and refuses prototype-polluting keys. That narrows over-posting
  but does not by itself prevent mass assignment: a schema can legitimately
  declare a field that a client should not be allowed to set. The
  request-to-domain mapping layer is what closes the gap — see
  [ADR-0009](0009-request-validation-and-mapping.md).
- AI responses will be validated against Zod schemas converted to JSON Schema for
  the provider request, so the schema sent to the model and the schema used to
  validate its reply are the same object.
- Forms use the same schemas through `@hookform/resolvers`, so a rule enforced by
  the server is also enforced in the browser without being written twice.

class-validator, the NestJS default, is deliberately not used.

## Consequences

- One mental model and one dependency for validation across the stack.
- Schemas defined in `@wdrg/contracts` are usable by both applications, so a
  server-side constraint is available to client-side form validation for free.
- Zod parse failures carry structured issue paths, which map directly onto the
  error envelope's `details` array and from there onto form fields.
- `@nestjs/swagger` cannot infer OpenAPI schemas from Zod the way it can from
  decorated classes. Documented request/response schemas need explicit
  declaration; that is a known cost, paid where the documentation matters.
- Zod 4 is pinned exactly. Its inference is central enough that a minor version
  difference between packages could produce confusing type mismatches.

## Alternatives considered

**class-validator + class-transformer.** The NestJS default. Rejected: decorators
on classes cannot be shared with the browser bundle or reused for AI response
validation, the validated type is not derived from the rules, and
class-transformer's implicit conversions have surprising edge cases.

**JSON Schema + Ajv.** The natural fit for AI structured outputs, and Ajv is
fast. Rejected as the primary language: hand-written JSON Schema has no
TypeScript inference, so types and schemas drift. Zod converts to JSON Schema
where the provider needs it, which gets the benefit without the drift.

**TypeBox.** Good JSON Schema story and good inference. Rejected as the smaller
ecosystem, with weaker form-library integration and no clear advantage for the
other four use cases.
