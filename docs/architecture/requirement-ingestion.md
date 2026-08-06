# Requirement ingestion

> Phase 3. How a client's document becomes reviewable, citable evidence.

## The pipeline

```
     paste text ──────────────────────────────────────┐
                                                      │
  upload file                                         │
       │                                              │
       ▼                                              │
  ┌─────────────┐   rejected                          │
  │  validate   │ ─────────────▶ nothing is stored    │
  └──────┬──────┘                                     │
         │ accepted                                   │
         ▼                                            │
  ┌─────────────┐                                     │
  │    store    │  opaque object id, private path     │
  └──────┬──────┘                                     │
         │                                            │
         ▼                                            │
  ┌─────────────┐                                     │
  │    queue    │  idempotent on (source, attempt)    │
  └──────┬──────┘                                     │
         │                                            │
         ▼                                            │
  ┌─────────────┐   no text layer   ┌─────────────┐   │
  │   extract   │ ────────────────▶ │     OCR     │   │
  └──────┬──────┘                   └──────┬──────┘   │
         │                                 │          │
         └────────────┬────────────────────┘          │
                      ▼                               │
             ┌─────────────────┐                      │
             │   revision 0    │ ◀────────────────────┘
             └────────┬────────┘
                      ▼
      REVIEW_REQUIRED  or  READY
                      │
                      ▼
              corrections → revision 1, 2, …
                      │
                      ▼
                   REVIEWED
```

**Nothing is stored until it has been validated, and nothing is queued until it
has been stored.** A file that fails validation never reaches the disk; a file
that fails to store never becomes a job pointing at bytes that are not there.

## Validation, in order

Cheapest first, and each step may end the process.

| #   | Check             | Refuses                                                                                  |
| --- | ----------------- | ---------------------------------------------------------------------------------------- |
| 1   | Filename          | Traversal, control characters, bidi overrides, reserved names, no extension, over-length |
| 2   | Size              | Empty files, files over `UPLOAD_MAX_FILE_BYTES`                                          |
| 3   | Extension         | Anything outside the supported set; legacy formats where conversion is off               |
| 4   | Declared MIME     | A browser type that contradicts the extension                                            |
| 5   | Content signature | Bytes that are a _different_ known format, or nothing recognisable                       |
| 6   | ZIP container     | Encrypted entries, expansion beyond the limit, an absurd compression ratio               |
| 7   | Encryption        | A PDF whose trailer declares `/Encrypt`                                                  |
| 8   | Checksum          | — (the only pass over the whole buffer, so it goes last)                                 |

Three independent signals have to agree before a file is processed. Extension and
declared type are claims made by whoever uploaded the file; the leading bytes are
not. A `.pdf` beginning `MZ` is a Windows executable, whatever the browser said —
and the rejection names it, because "this is an executable, not a PDF" is a
mistake a user can fix and "invalid file" is a mystery.

## Supported formats

| Format               | Read by                    | Traceability                          |
| -------------------- | -------------------------- | ------------------------------------- |
| PDF (digital)        | `pdfjs-dist`               | Page number                           |
| PDF (scanned)        | Rasterised, then Tesseract | Page number, OCR region               |
| DOCX                 | `mammoth`                  | Nearest heading, paragraph index      |
| TXT                  | Built in                   | Line number                           |
| CSV                  | Built in                   | Row number, header labels             |
| XLSX                 | `exceljs`                  | Sheet name, row number, A1 cell range |
| PNG, JPG, JPEG, WEBP | Tesseract                  | OCR region                            |

`.doc` and `.xls` are **not** natively supported. They are refused unless
`LEGACY_CONVERSION_ENABLED` is set and LibreOffice is installed — see ADR-0015.

## What "never invents a reference" means

Every extracted block carries a `SourceReference` populated only with what its
format genuinely knows. A CSV row has a row number and no page; a PDF line has a
page and no sheet; a DOCX paragraph has a heading and an index but neither.

An **absent field is information**. It says the extractor could not locate the
content more precisely — which is different from locating it at page 1, and a
requirement baseline that cites a page that was guessed is worse than one that
admits it cannot cite a page at all.

## Parser safety

Every one of these bounds hostile input, and each lives in exactly one place:

| Risk                          | Control                                                                                                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zip bomb                      | The ZIP central directory is read and its declared sizes summed. **Nothing is inflated** — inflating to measure _is_ the attack. Also bounded by compression ratio, so a small file with an absurd ratio cannot slip under an absolute limit. |
| XXE                           | The libraries do not resolve external entities. `containsXmlEntityDeclaration` is a second line, because "the library is safe" is a claim about a version.                                                                                    |
| Spreadsheet formula execution | Formulas are read as text and never evaluated, in both CSV and XLSX, and a warning says so.                                                                                                                                                   |
| Runaway parser                | A wall-clock timeout around every extraction, plus ceilings on blocks, rows and pages.                                                                                                                                                        |
| Macro execution               | `mammoth` reads document XML and has no execution model. Nothing to disable — a stronger position than having disabled it.                                                                                                                    |
| Memory exhaustion             | Multer's size limit is enforced before the request body is read; blocks are capped per source.                                                                                                                                                |

The timeout bounds how long a **user** waits and how long a job holds its claim —
not how long the CPU works, because JavaScript cannot cancel a running promise.
That is a real limitation, and bounding the latter would mean a process per
extraction, which is the right answer at a scale this application is not at.

## Uploaded content is evidence, never instruction

Requirement content is quoted, cited and reasoned about. It never instructs.

Phase 3 makes no AI calls, so nothing here defends a live model yet. The boundary
exists now because the defence has to be **structural**, and structure is decided
when the data model is designed — not when the first prompt is written. By the
time Phase 4 assembles a request, evidence is already a separate, typed,
non-instruction thing, so the safe path is the easy one.

| Trust level      | Origin                                   | May influence                         |
| ---------------- | ---------------------------------------- | ------------------------------------- |
| `SYSTEM`         | Application source and versioned prompts | Everything                            |
| `USER_DIRECTIVE` | A choice from a closed set in our own UI | The workflow                          |
| `EVIDENCE`       | Uploaded files, pasted text, OCR output  | Nothing. It is read, cited and quoted |

Text matching an instruction-shaped pattern — "ignore previous instructions",
"reveal the system prompt" — is **flagged and kept verbatim**. It is never
stripped: silently editing a client's requirements would be a far worse failure
than quoting an odd sentence. The UI says exactly that where it appears.

## Collections

### `requirement_sources`

Lifecycle, file metadata, review state and cached counters. Indexes:

| Index                         | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `sourceId` unique             | Lookup                                               |
| `{projectId, createdAt}`      | The list query — the most frequent read in the phase |
| `{projectId, checksumSha256}` | Duplicate detection, scoped to the project           |
| `{projectId, status}`         | The worker's sweep and the retention job             |

The checksum index is deliberately **not unique**: a user may have a documented
reason to keep two copies of the same bytes, and a unique index would make that
impossible rather than merely warned about. It is scoped to the project so one
project's upload cannot reveal whether another holds the same file.

### `extracted_content`

One immutable document per revision. `{sourceId, revision}` is unique — two
documents claiming to be revision 3 would make "the current content" ambiguous,
and the ambiguity would surface as a user seeing someone else's correction.

Content lives here rather than on the source because a 500-page PDF produces tens
of thousands of blocks, and _listing_ sources must not load every block of every
one of them.

### `extraction_jobs`

Queue state. `idempotencyKey` unique; `{state, runAfter}` for the claim query.

## Retry

A retry is offered only where it could help. `STORAGE_FAILURE`, `QUEUE_FAILURE`,
`EXTRACTION_FAILED`, `EXTRACTION_TIMEOUT` and `OCR_FAILED` are transient.
`UNSUPPORTED_FORMAT`, `CORRUPTED_FILE`, `PASSWORD_PROTECTED` and
`SIGNATURE_MISMATCH` are properties of the file, and retrying only delays the
moment the user is told the truth — three times over.

Both the UI and the API enforce this, and the attempt limit
(`EXTRACTION_MAX_ATTEMPTS`) bounds the rest.

## Known limitations

- **Storage is local disk only.** The S3 adapter is not implemented — ADR-0011.
- **`.doc` and `.xls` conversion is off by default**, and its enabled path is not
  exercised by CI — ADR-0015.
- **No malware scanner ships.** `MALWARE_SCANNER=none` records `NOT_SCANNED`,
  which is deliberately not `CLEAN`; `reject` refuses every upload.
- **Table structure is approximated.** DOCX cells and XLSX rows keep their
  coordinates but not their full grid geometry; OCR loses table structure
  entirely.
- **Handwriting is not reliably recognised.** Stated in the UI on every image.
- The worker runs in the API process — ADR-0012.
