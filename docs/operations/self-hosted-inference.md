# Self-hosted inference

> Requirement analysis runs on a model you host. No hosted API, no vendor
> account, no API key, and **no requirement content leaves your network**.

This is enforced, not merely intended: the endpoint policy refuses hosted-vendor
domains, production additionally requires a private address, and there is no
default endpoint anywhere — an unconfigured deployment fails rather than reaching
somewhere.

## Development: Ollama

One binary, one pull, no account.

```bash
# Install (or download the tarball from the releases page for a rootless install)
curl -fsSL https://ollama.com/install.sh | sh

ollama serve &                        # http://127.0.0.1:11434
ollama pull qwen2.5:7b-instruct       # ~5 GB
```

Then:

```bash
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434
AI_MODEL_PROFILE=qwen2.5-7b-instruct
```

**If the machine cannot hold the 7B weights**, use the 3B fallback. It needs
about 2.5 GB and runs acceptably on CPU alone:

```bash
ollama pull qwen2.5:3b-instruct
AI_MODEL_PROFILE=qwen2.5-3b-instruct
```

It is meaningfully weaker at conflict detection — the task that requires relating
two statements pages apart — and its profile says so. Use 7B where you can.

### Verifying it works

```bash
pnpm --filter @wdrg/api test:ollama
```

Runs the provider against your actual server: connectivity, model availability, a
real structured task validated against a real schema, timeout handling, and a
check that a hosted endpoint is refused even when configured. It skips loudly if
no server is reachable rather than passing quietly.

This is **not** part of `pnpm test` and CI never runs it. Hosted CI must not
download gigabytes of weights to check that business logic works — the
deterministic provider covers that far faster and without the variance.

## Production: an OpenAI-compatible server you run

vLLM, llama.cpp's server and TGI all speak the same protocol. Which one is right
depends on your hardware.

```bash
# vLLM, for example
vllm serve Qwen/Qwen2.5-7B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 32768
```

```bash
AI_PROVIDER=local-openai-compatible
AI_BASE_URL=http://vllm.internal:8000
AI_MODEL_PROFILE=<your profile>
AI_MAX_CONTEXT_TOKENS=32768        # match how the server was launched
```

**The protocol is borrowed. The service is not.** `local-openai-compatible`
means "speaks the OpenAI wire format", which is now the de-facto standard for
local inference servers. No API key is sent — a server that needs authentication
should sit behind something that provides it.

### Before production

`AI_MODEL_PROFILE=self-hosted-openai-compatible` is deliberately **not**
production-approved: it names no model, so no licence has been recorded, and
startup refuses it. Copy the profile, name your model, record its licence, and
set `validationStatus` once both the licence and the behaviour have been checked.
See [ADR-0018](../adr/0018-model-profile-strategy.md).

## What production refuses at startup

| Setting                              | Rule                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER=deterministic`          | Refused. It returns fixtures, and a baseline made of fixtures would look exactly like a real one              |
| `AI_BASE_URL` on a vendor domain     | Refused. In development too — a developer must not be able to send a client's requirements to a vendor either |
| `AI_BASE_URL` on a public address    | Refused in production. Self-hosted means your network                                                         |
| `AI_BASE_URL` containing credentials | Refused. They end up in logs                                                                                  |
| `AI_MODEL_PROFILE` unset or unknown  | Refused                                                                                                       |
| A profile not `production-approved`  | Refused                                                                                                       |
| A profile flagged for legal review   | Refused                                                                                                       |
| A profile without structured output  | Refused. Every task returns schema-validated JSON                                                             |

Every problem is reported at once, each with a fix, and no setting's _value_ is
ever printed.

## Where a request is allowed to go

The endpoint policy is a security control, not a setting. Requirement documents
are a client's confidential material, so the destination of an inference request
is the most consequential thing this application decides — and it is decided at
the socket, not in this document.

| Threat                                         | What happens                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hosted model vendor                            | 33 vendor domains refused outright, in development as well as production                        |
| Cloud metadata service                         | Refused by address and by hostname, in every notation — including `::ffff:169.254.169.254`      |
| Wildcard DNS reflectors, tunnels               | `nip.io`, `ngrok`, `trycloudflare.com` and similar refused: the destination is not the hostname |
| Alternate IP encodings                         | `0177.0.0.1`, `2130706433`, `127.1` refused rather than decoded                                 |
| A name that resolves somewhere else            | Resolved per request; **every** returned address validated, not the first                       |
| A name with one private and one public address | Refused outright — which address you would reach depends on the resolver                        |
| **DNS rebinding**                              | The socket connects to the validated address. No resolution happens at connection time          |
| A peer that turned out to be somewhere else    | Re-validated after connect, **before the request body is written**                              |
| A server answering `302`                       | Refused, never followed — following one hands destination choice to the server                  |
| Credentials in the URL                         | Refused; they end up in logs                                                                    |

Both adapters go through the same client, so the policy cannot apply to one and
not the other. `AI_REQUIRE_REMOTE_ENDPOINT=true` additionally refuses loopback in
production, for a deployment whose policy requires inference on a separate
internal host. See [ADR-0021](../adr/0021-inference-endpoint-hardening.md).

## Choosing a model

| Consideration         | Why it matters                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Licence**           | Must permit commercial use. Prefer Apache-2.0 or MIT — several popular model licences permit commercial use _with conditions_ (acceptable-use policies, user thresholds, naming requirements), and those need a lawyer, not a shrug |
| **Structured output** | Every task returns schema-validated JSON. A model that cannot do it reliably is unusable here regardless of its other merits                                                                                                        |
| **Context length**    | Larger contexts mean fewer chunks and better cross-document conflict detection                                                                                                                                                      |
| **Hardware**          | 7B at Q4 wants ~6 GB; 3B wants ~2.5 GB. CPU works and is slow                                                                                                                                                                       |

Record whatever you choose in the [dependency
inventory](../architecture/dependency-and-service-inventory.md) alongside its
licence. **Weights are never committed to Git** — they are large, they are not
source, and several licences forbid redistribution.

## Honest expectations

Self-hosted inference means output quality is bounded by what you can run. A 3B
or 7B model is not a frontier model, and the analysis it produces will be
correspondingly weaker — it will miss subtle contradictions between distant parts
of a long document, and it will sometimes over-produce requirement items from a
single sentence.

This is a permanent, structural trade-off of the architecture, not a temporary
gap. Every stage is therefore reviewable and correctable by a human, and the
baseline cannot be approved while blocking conflicts or unanswered clarifications
remain. The model drafts; a person decides.

There is no per-token cost, no rate limit and no vendor outage. What there is
instead is your own capacity planning, and a GPU bill if you want speed.
