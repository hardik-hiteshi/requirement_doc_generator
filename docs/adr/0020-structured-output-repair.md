# ADR-0020: Bounded repair, and never persisting unvalidated output

## Status

Accepted (Phase 4)

## Context

Every analysis task returns structured JSON. Language models produce it
imperfectly: wrapped in prose, in code fences, with an extra field, with a
reused identifier, and occasionally citing a source that does not exist.

Two failure modes matter, and they pull in opposite directions. Being too strict
throws away output that was correct apart from three backticks. Being too lenient
puts model output into a requirement baseline without checking it — and a
baseline built from unchecked output is worse than none, because it is believed.

## Decision

**Three stages, each able to stop the process, and unvalidated output is never
persisted.**

1. **Extraction.** Find the JSON. Fences are stripped, surrounding prose is
   ignored, and a balanced-brace scan handles output with text on both sides.
   Leniency here costs nothing: the _content_ is then held to the full standard.
2. **Schema validation.** The published Zod schema, with unknown keys rejected
   rather than stripped — stripping silently discards something the model thought
   mattered.
3. **Semantic validation.** What a schema cannot express: identifiers unique
   within the response, and every cited source actually belonging to this
   project.

**Repair is bounded at two attempts.** A model that has produced invalid output
twice against the same schema is not one attempt from succeeding; it is telling
you the task is beyond it, and further attempts cost minutes of local inference
to reach the same answer.

**A repair prompt carries only the validation issues.** Not the previous output,
not the evidence. Two reasons and both are load-bearing: resending the evidence
grows the context on every attempt, which is how a repair loop causes the
overflow it was meant to avoid; and a repair prompt is a second place project
content could leak into, so it is kept free of it by construction.

**A hallucinated source reference is never repaired.** Asking again invites the
model to invent a different one. The result is discarded and the run fails, with
a message saying exactly that.

## Consequences

- Nothing reaches the database without passing all three stages.
- A failure names its stage, so "the model produced invalid JSON" and "the model
  cited a source that does not exist" are different events with different fixes.
- A weak model on a complex schema fails rather than degrading, which is the
  right direction: a smaller model producing nothing is recoverable, and one
  producing plausible nonsense is not.
- Repair costs wall-clock time on local hardware. Two attempts is a deliberate
  ceiling on that.

## Alternatives considered

**Unbounded repair until it validates.** Rejected: unbounded work on local
inference is unbounded minutes, and the failure it is papering over is usually
structural.

**Repair by resending everything including the last output.** The obvious
approach, and rejected for both reasons above.

**Accept partial output and fill the rest with nulls.** Rejected: a requirement
item with invented empty fields is indistinguishable from one where the evidence
genuinely said nothing, and that distinction is the whole basis of the "never
invent" rule.

**Constrained decoding only, without validation.** Ollama's `format: json` and
vLLM's guided decoding both help, and neither is universal or sufficient — they
guarantee _JSON_, not _this schema_, and say nothing about whether a citation is
real.
