# ADR-0017: Self-hosted inference, never a hosted model vendor

## Status

Accepted (Phase 3, ahead of Phase 4)

## Context

Phase 4 needs a language model. The obvious choice is a hosted API — Anthropic,
OpenAI, Google — and earlier documents in this repository named Claude as the
provider.

Two constraints make that the wrong answer.

**Cost model.** A hosted model is metered. The core application must run with no
paid third-party API, so a metered dependency on the critical path is disallowed
outright.

**Data.** The evidence this application reasons over is a client's requirement
documents: scope, commercial terms, sometimes the contract itself. Sending that
to a vendor is a disclosure decision, and it is not one this codebase should
make on a deployment's behalf. Many of the organisations that would use a
requirement generator cannot make it at all.

This is recorded now, before Phase 4, because the decision is only cheap while
no prompt has been written. Once a hosted SDK is in the dependency tree and its
idioms are in the code, "swap the provider" stops being a configuration change.

## Decision

**Inference runs on infrastructure the operator controls. Always.**

| Environment | Provider                                                                   | Why                                                                      |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Development | Ollama                                                                     | One binary, one `ollama pull`, runs on a laptop                          |
| Production  | An OpenAI-protocol-compatible local server — vLLM, llama.cpp's server, TGI | Throughput, batching, and a protocol every client library already speaks |

**The protocol is borrowed. The service is not.** `local-openai-compatible`
means "speaks the OpenAI wire format", which is now a de-facto standard that
vLLM, llama.cpp, LM Studio and others implement. `AI_BASE_URL` points at a
server the operator runs. There is no default, and a provider selected without
a base URL fails at startup — so the configuration cannot silently fall back to
`api.openai.com`.

**Model rules**, enforced by documentation and review rather than by code, since
a model is a deployment artefact:

- The model must permit commercial use, and its licence must be recorded in the
  dependency inventory before it ships.
- Weights are never committed to Git. They are large, they are not source, and
  several licences forbid redistribution.
- The model is configurable (`AI_MODEL`), because the right size depends on the
  hardware available and on how good the output has to be.
- **No requirement content leaves the operator's infrastructure.** This is the
  property the whole decision exists to preserve.

The `AiProviderPort` written in Phase 1 needs no structural change. It already
separates trusted instructions from untrusted evidence, names a versioned prompt
and declares a response schema — none of which is vendor-specific. Only its
documentation changes.

## Consequences

- **Output quality is bounded by what the operator can run.** A 7B model on a
  laptop is not a frontier model, and the estimates and documents it produces
  will be correspondingly weaker. This is a real, permanent trade-off, and the
  product documentation says so rather than implying parity.
- **GPU capacity becomes an operational requirement** for anything beyond
  development. What that costs depends entirely on the model chosen, which is a
  Phase 4 decision.
- **No per-token cost, no rate limit, no vendor outage.** The failure modes move
  from someone else's status page to the operator's own capacity planning.
- **No data leaves the building.** For a product built around commercially
  sensitive client documents, this is the point, not a side effect.
- The token-budget and cost-estimation machinery in `AiProviderPort` stays. It
  no longer describes money — it describes context-window pressure and the
  compute the operator is paying for in electricity.

## Alternatives considered

**Anthropic Claude as the default, with a self-hosted option.** Rejected: an
optional escape hatch on a paid default means the tested path is the paid one,
and the self-hosted path is discovered to be broken by whoever first needs it.

**A hosted model behind a feature flag, off by default.** Rejected for the same
reason, and because the constraint is explicit that optional paid providers must
not be part of the required flow. An adapter someone could enable is fine; one
the application depends on is not.

**No AI at all, with rule-based extraction and estimation.** Genuinely viable
for parts of the product and much cheaper to operate. Rejected because the
analysis the brief asks for — conflicts, gaps, ambiguity, feature decomposition
from prose — is not reachable with rules. Worth revisiting per-document: not
everything needs a model.

**Fine-tuning a small model on requirement documents.** Interesting, and out of
scope for a phase that has not yet run a single inference. Revisit once there is
real output to compare against.
