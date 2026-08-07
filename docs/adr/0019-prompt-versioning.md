# ADR-0019: Prompts are versioned, registered, and checksummed

## Status

Accepted (Phase 4)

## Context

The output of this phase becomes a requirement baseline, which becomes a signed
document. Months later, someone will ask why a particular requirement says what
it says.

"The AI generated it" is not an answer. "Produced by qwen2.5-7b-instruct under
`requirement.extract` v1" is one — but only if that record is true, and it is
only true if the prompt behind v1 has not quietly changed since.

## Decision

**One registry, one version per prompt, one checksum over all of them.**

Every prompt is a constant in `prompt-registry.ts`. Every task execution records
the task id, the prompt version, the provider, the model and the model profile.

A test pins the registry's checksum. Editing a prompt without bumping its version
changes the checksum and fails that test. The point is not that prompts are
frozen — it is that a change is deliberate and visible in a diff, because silent
prompt drift makes every recorded `promptVersion` a lie and there is no way to
notice after the fact.

**No project content is ever interpolated into a prompt.** Prompts are system
messages built from constants; requirement content arrives as a separate user
message wrapped in delimiters. A test asserts no prompt contains a template
placeholder, which is a crude check for a real property.

## Consequences

- Output is attributable. A requirement can be traced to the exact instruction
  and model that produced it.
- Improving a prompt means adding a version. Old records keep pointing at the
  behaviour they were produced by.
- The checksum test needs updating whenever a prompt legitimately changes, which
  is mild friction on purpose — it is the moment to ask whether the version
  should move too.
- Prompts live in code rather than a database. They are behaviour, they belong in
  review, and a prompt someone can edit at runtime is one that can change without
  a diff.

## Alternatives considered

**Prompts in the database, editable at runtime.** Attractive for iteration
speed, and rejected: an unreviewed change to a prompt is an unreviewed change to
what the product asserts about a client's requirements.

**No versioning, just improve the prompt.** Rejected — it destroys attribution,
which is the reason any of this is recorded.

**Version the whole registry rather than each prompt.** Simpler, and it makes
every recorded version change when any prompt changes, so the record stops
distinguishing what actually moved.
