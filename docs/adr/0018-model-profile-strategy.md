# ADR-0018: Model profiles as data, not a hardcoded choice

## Status

Accepted (Phase 4)

## Context

The application needs a language model. The obvious shape is to pick the best
one and hardcode it.

That is wrong here for a reason specific to self-hosting: **which model is best
depends on facts this codebase does not have.** How much GPU memory the operator
has. Whether their legal team accepts a licence with an acceptable-use policy.
Whether "good enough" means a 3B model on a laptop or a 70B on a server. A
hardcoded choice answers all three on the operator's behalf, wrongly.

## Decision

**A model is described by a profile, and the profile is data.**

Each records what someone choosing between models actually needs: the licence
and its commercial-use status, where the weights come from, an immutable
identifier for them, context and output limits, whether it can produce
structured output, recommended hardware, what it is _not_ good at, and how
thoroughly it has been validated.

Three gates gate production use, and all three exist to stop a problem being
discovered late:

| Gate                                         | Why                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `provider !== 'deterministic'`               | A test fixture producing a requirement baseline would produce one made of nothing, presented as confidently as a real one |
| `validationStatus === 'production-approved'` | An unvalidated profile is an untested one, whatever the model's reputation                                                |
| `!requiresLegalReview`                       | A licence flagged for review has not had it                                                                               |

`commercialUse` has four values rather than two because several widely-used model
licences permit commercial use _with conditions_ — an acceptable-use policy, a
user-count threshold, a naming requirement. Recording that as "yes" would hide
the conditions from whoever has to comply with them.

**Weights are never committed.** A profile names a model and records where its
weights came from; it never carries them.

### The reference profiles

**Qwen2.5 7B Instruct** is the reference. Apache-2.0 — no acceptable-use policy,
no threshold, no naming requirement, nothing to route past a lawyer. For a
product whose entire constraint is "no vendor dependency", a licence with no
conditions is worth more than a few benchmark points. It is also genuinely good
at constrained JSON, which every task in this phase needs.

**Qwen2.5 3B Instruct** is the fallback for machines that cannot hold the 7B
weights, and it is what has actually been validated here: the development
machine has 15 GB of memory with a Docker stack alongside, which does not leave
room for 7B. It is meaningfully weaker at conflict detection — the task that
needs holding two distant statements in mind — and that is recorded in its
limitations rather than left to be discovered.

**The self-hosted OpenAI-compatible profile names no model**, because which
weights sit behind a vLLM server is a deployment's choice. It is deliberately
`requiresLegalReview: true` and `untested`: a profile that does not name a model
cannot have had its licence recorded, and approving it would let anything
through the gate that exists to prevent exactly that.

## Consequences

- Adding a model is adding an entry. Nothing in the application knows anything
  about any particular model.
- A deployment must choose deliberately. There is no default profile, and an
  unconfigured one fails at startup.
- The gates are conservative, and a deployment that wants to run an unvalidated
  model in production has to edit a profile to say so — which is the point. It is
  a decision, and it should look like one in the diff.
- Recording a weights digest is best-effort. Ollama tags are mutable in
  principle; where a distribution offers a real digest, the profile carries it.

## Alternatives considered

**Hardcode one model.** Rejected for the reason in the context.

**Let a deployment configure a bare model name with no profile.** Simpler, and
rejected: the licence, the context limit and the structured-output capability all
have to come from somewhere, and "the operator remembered" is not somewhere.

**Detect capabilities at runtime by probing the server.** Appealing, and it does
not answer the licence question at all — which is the one that cannot be
recovered from later.
