# ADR-0014: Tesseract as a local binary, behind an OCR port

## Status

Accepted (Phase 3)

## Context

Scanned documents and photographed whiteboards are ordinary requirement sources.
Neither has a text layer, so optical character recognition is not an enhancement
for them — it is the only way they can be read at all.

The realistic options differ in ways that matter well beyond accuracy: a cloud
vision API is the most accurate and sends a client's requirement documents to a
third party; a WASM build runs anywhere and is materially slower and worse; a
local binary is fast and accurate and must be installed.

## Decision

**Tesseract, invoked as a subprocess, behind `OcrProviderPort`.**

The port exists because the choice above is a deployment decision — a deployment
with a data-residency obligation and one without should be able to differ by
configuration rather than by a rewrite.

Three things are non-negotiable in the contract:

**Confidence is part of the result.** An OCR output without per-word confidence
cannot be reviewed intelligently: the reader has no way to know which words to
check, so they check none. Output is read as TSV, not plain text, because plain
text discards exactly that.

**Low confidence is never treated as accurate.** Anything OCR touched lands in
`REVIEW_REQUIRED`, never `READY`. A line's confidence is its _lowest_ word, not
its mean — averaging hides the one word that was guessed.

**Limitations are stated in the UI.** `limitations()` returns plain language that
the review panel shows, including that handwriting is not reliably recognised.
That warning appears on every image, not only on poor ones: a user photographing
a whiteboard needs to know before they trust the output, and a confidence score
alone does not tell them handwriting is the problem.

`isAvailable()` is checked at startup and before every call. A deployment with no
engine gets a clear refusal on image uploads rather than empty content that reads
as a blank document.

## Consequences

- Tesseract and its language data are a documented prerequisite, installed in CI
  and named in the local-development guide. `OCR_ENABLED=false` is the supported
  way to run without one.
- A subprocess isolates the engine: a malformed image kills a child process, not
  the API.
- Accuracy is what Tesseract's accuracy is. Printed text recognises well;
  handwriting does not; layout is approximated and tables lose their structure.
  All four are stated to the user rather than discovered by them.
- Scanned PDF pages are rendered at scale 2 (~150 dpi) before recognition.
  Tesseract's accuracy is a function of glyph pixel height, and a page rendered at
  its nominal 72 dpi recognises badly.

## Alternatives considered

**`tesseract.js` (WASM).** No binary to install and identical behaviour
everywhere, which is a real advantage for CI. Rejected: materially slower and
less accurate on exactly the low-quality scans that most need OCR, and it would
make the default experience the worst one.

**AWS Textract or Google Vision.** Best accuracy by a wide margin, and structured
table extraction that Tesseract cannot do. Rejected as the default: it requires
credentials to run any test, makes CI depend on a paid external service, and
sends client requirement documents off-site. It is the obvious first alternative
adapter, which is why the port exists.
