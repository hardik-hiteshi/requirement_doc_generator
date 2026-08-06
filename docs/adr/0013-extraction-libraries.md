# ADR-0013: One extractor per format, behind a registry

## Status

Accepted (Phase 3)

## Context

Six formats have to become reviewable content, and they have almost nothing in
common. A PDF has pages; a spreadsheet has sheets, rows and cells; a text file
has lines; an image has nothing until OCR gives it words.

The tempting shape is one function with a switch statement and a string result.
It is also the shape that loses the thing later phases need most: **where each
sentence came from**. A requirement baseline that cannot cite "page 4" or
"Sheet2!B12" is not auditable, and a client cannot check it.

## Decision

**A registry of extractors, one per format, all producing the same block shape.**

Each block carries a `SourceReference` populated only with what that format
genuinely knows. A CSV row has a row number and no page; a PDF line has a page
and no sheet. **Nothing is invented** — an absent field means the extractor could
not locate the content more precisely, which is different information from
locating it at page 1.

Libraries, and why each:

| Format | Library                 | Why this one                                                                                                                                                                                                       |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PDF    | `pdfjs-dist`            | The only maintained JS PDF stack that gives positioned text per page. Page numbers are the entire point.                                                                                                           |
| DOCX   | `mammoth`               | Converts to semantic HTML rather than a flat string, so headings stay headings and table cells stay in rows. No execution model at all, so macros are not a risk to disable — they are a risk that does not exist. |
| XLSX   | `exceljs`               | Exposes a formula's _text_ separately from its cached result, which is what makes "never evaluate" implementable rather than aspirational.                                                                         |
| CSV    | Written here            | The grammar is small, the behaviour on slightly-malformed client exports matters, and a dependency buys very little.                                                                                               |
| TXT    | Written here            | Encoding detection by BOM, then an honest admission when the encoding was guessed.                                                                                                                                 |
| Images | Tesseract, via ADR-0014 | —                                                                                                                                                                                                                  |

Two limits live outside the extractors, in one place each: the block ceiling in
`BlockBuilder`, and the wall-clock timeout in `ExtractionService`. Six
implementations of the same guard is five chances to get it wrong.

`pdfjs` ships ESM only and this application compiles to CommonJS, where a literal
`import()` is rewritten to `require()`. The import specifier is therefore built
through `Function`, beyond the transpiler's reach. That is a workaround and is
commented as one.

## Consequences

- Adding a format is registering a class. No existing file changes, which is what
  stops the upload service accumulating knowledge of every format's quirks.
- Output is uniform, so the review UI, corrections and Phase 4's evidence
  assembly each have one thing to consume rather than six.
- Every library is a supply-chain surface, and three of them parse hostile input.
  The mitigations are structural: validation before any parser sees a file, a
  timeout around every extraction, a block ceiling, and a decompression limit
  checked from the ZIP directory without inflating anything.
- Scanned PDF pages are rasterised with `@napi-rs/canvas`, which ships prebuilt
  binaries — no compiler on any machine — and is loaded lazily so a deployment
  that never receives a scan never pays for it.

## Alternatives considered

**`pdf-parse`.** CommonJS, so no ESM workaround. Rejected: it returns one text
blob, and reconstructing page boundaries from it is guesswork.

**Apache Tika in a sidecar.** Handles far more formats and is genuinely better at
several. Rejected: a JVM service to deploy, operate and secure, for six formats
this application actually accepts.

**One extractor with a switch.** Rejected for the reason in the context: it grows
a branch per format quirk in a file everything else depends on.
