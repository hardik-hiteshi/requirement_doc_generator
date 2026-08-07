# ADR-0021: Connecting to a validated address, not to a name

## Status

Accepted (Phase 4)

## Context

An inference request carries a client's confidential requirement documents out
of the process. Where that request goes is therefore the single most
consequential decision this application makes, and until now it was made once —
by checking the configured URL.

Checking a URL is not enough, because every layer between "a URL in
configuration" and "bytes on a socket" can produce a different answer than the
check saw:

- A **hostname** is a promise about the future, not a fact. `vllm.internal` can
  resolve to `10.0.0.5` when it is checked and to `169.254.169.254` when the
  socket opens. With a TTL of zero this is trivial to arrange, and it is the
  entire mechanism of **DNS rebinding**.
- A name can resolve to **several addresses**, only some acceptable. Validating
  the first one and connecting to whichever the resolver picks means the check
  and the connection can disagree.
- An address can be written in a form the **checker and the resolver read
  differently**. `0177.0.0.1`, `2130706433` and `127.1` all reach loopback
  through `getaddrinfo`, and none of them look like `127.0.0.1` to a regular
  expression.
- `::ffff:169.254.169.254` is the **metadata service** wearing IPv6 notation.
- A server can answer **`302 Location:`** and choose the next destination
  itself, which inverts the whole arrangement: the destination is no longer the
  operator's decision.

The original policy also had a substantive classification bug. It treated
link-local (`169.254.0.0/16`) and carrier-grade NAT (`100.64.0.0/10`) as
"private", which meant `http://169.254.169.254` — the cloud instance metadata
service, which serves instance credentials to anything that can reach it —
passed the production check.

## Decision

**Classify, resolve, validate every answer, then connect to the address that was
validated.**

1. **Classification is exhaustive and separate from policy.**
   `classifyAddress` returns what an address _is_ — loopback, private,
   link-local, metadata, multicast, unspecified, broadcast, shared, reserved,
   public, malformed — for both IPv4 and IPv6, decoding IPv4-mapped IPv6 to the
   address it actually reaches. The policy is then a short list of which classes
   it accepts, which differs between development and production while the
   classification never does.

2. **Alternate encodings are refused, not decoded.** Reimplementing
   `inet_aton`'s quirks and agreeing with the resolver about every edge is a
   losing game. Refusing them costs an operator nothing: nobody configures an
   inference server as `0x7f000001` on purpose.

3. **Resolution happens per request, and every returned address is checked.** A
   name returning one private and one public address is refused outright as
   `mixed_addresses` rather than accepted on the strength of resolver ordering.
   An empty result is a refusal, not a pass.

4. **The socket connects to the validated address.** `SafeHttpClient` opens the
   connection to the address the guard checked, with the `Host` header and TLS
   server name carrying the configured name so virtual hosting still works. No
   resolution happens at connection time, so there is no second DNS answer to
   substitute — rebinding has nothing to rebind.

5. **The peer is re-validated before the body is written.** The request body is
   sent only after the socket has connected and `socket.remoteAddress` has
   passed the same policy. This should never fire; the day it does is the day it
   is the only thing between a client's requirements and somewhere they must not
   go.

6. **Redirects fail.** `node:http` does not follow them, and a 3xx is turned
   into a refusal before the response body is read. A cross-host redirect gets a
   louder message, but a same-host one is refused too — a client that follows
   redirects at all has handed destination choice to the server.

7. **Metadata endpoints and loop-through services are named explicitly.**
   Metadata hosts are checked _first_, because `metadata.google.internal` ends
   in `.internal` and `fd00:ec2::254` sits inside the unique-local range —
   both would otherwise be accepted for looking internal. Wildcard DNS
   reflectors (`nip.io` and friends) and tunnelling services (`ngrok`,
   `trycloudflare.com`) are refused because the destination is not what the
   hostname describes.

8. **Both adapters share one enforcement point.** Ollama and the
   OpenAI-protocol adapter both go through `SafeHttpClient`, so the policy
   cannot apply to one and not the other. There is a test that asserts it.

`fetch` is not used for inference, for the specific reason that points 4, 5 and
6 cannot be expressed through it.

## Consequences

**Good.** The strongest property this application can offer about client data —
that requirement content reaches only an inference server the operator runs —
is enforced at the socket rather than asserted in a document. 135 tests cover
the classification matrix, the fourteen named threat cases, and both adapters.

**Cost.** No connection pooling: each request opens a fresh socket, because a
pooled one could have been opened to an address that was permitted when the pool
was warm and is not now. Against inference latency measured in seconds this is
not measurable.

**Loopback in production is permitted by default**, with
`AI_REQUIRE_REMOTE_ENDPOINT=true` to refuse it. "The model runs on this box" is
the most common legitimate production shape for a deployment of this size, and
refusing it would push operators towards exposing the inference server on a
network instead — worse for exactly the property this ADR is about.

**A denylist is never complete.** The hosted-vendor and loop-through lists are
the second line. The first is that a deployment must name its own endpoint, with
no default that reaches anywhere; the third is that in production the resolved
address must be internal, which catches a vendor no list has heard of.

**Nothing here needs a paid service.** `node:dns` and `node:http` do all of it.
