# Documents

Phase 7. One engine, a composer per document, and five collections.

## The shape

```
DocumentsController ── one set of routes, document type in the path
        │
DocumentsAiService ─── the model's half; falls back to the engine on any failure
        │
DocumentsService ───── the engine: status, versions, edit protection,
        │               dependency graph, validation, approval, audit
        ├── UpstreamReader ─── the approved baseline, locked stack, approved estimate
        ├── UnderstandingComposer ─── sections, and what makes them valid
        ├── FeatureListingComposer ── rows, coverage, reconciliation
        └── DocumentsRepository ───── five collections
```

Adding a document is a composer and a row in `DOCUMENT_DEPENDENCIES` — ADR-0033.

## What each piece owns

**`@wdrg/contracts/documents`** holds everything that is arithmetic or vocabulary:
the status table, the dependency graph, outdated propagation, coverage,
reconciliation, duplicate and hierarchy detection, the forbidden-content patterns,
the strict CSV serialiser and its validator. All of it is pure and unit-tested
without a database — 98 tests.

**`DocumentComposer`** knows one document: which sections exist, which requirements
belong where, what makes it valid, which requirements it is answerable for. It
takes no provider and cannot make a network call.

**`DocumentsService`** knows nothing about any particular document and owns
everything else. It is the largest file in the phase, deliberately: "how does
approval work" is one method rather than a comparison across five services.

**`DocumentsAiService`** wraps the engine. It runs four versioned tasks and folds
the result into the deterministic composition. Every failure path falls back.

## The dependency graph

```
approved requirement baseline
           ↓
   Our Understanding
           ↓
    Feature Listing  ←  locked technology stack
                     ←  approved estimation snapshot
```

`DOCUMENT_DEPENDENCIES` records upstream artifacts and prerequisite documents per
type, for all seven. `lockFor` turns that into a lock with a reason — unimplemented
first, then a missing upstream artifact, then an unapproved prerequisite, in that
order because a missing baseline is the more fundamental problem.

`documentOutdatedReasons` compares the versions a document was written against with
the versions that are current. Three cases:

- **a version changed** — reported with both numbers;
- **an input disappeared** (a stack unlocked, an estimate reopened) — reported as
  no longer approved, which a version comparison cannot see;
- **a baseline went stale without changing version** — Phase 4 keeps an
  approved-then-outdated baseline at the same version, so the engine checks
  `baselineCurrent` separately.

A prerequisite document changing is recorded on the dependent document when it
happens, by `markDependentsOutdated`. Nothing is regenerated: an approved document
that goes out of date keeps its content and gains a status and a reason.

## Composition

`compose` is deterministic and complete. Our Understanding assigns requirements to
its fifteen template sections — by category where Phase 4 already classified them,
by the words the requirements use where a heading is not a category — and writes a
plain body citing each requirement key. Feature Listing builds one row per
non-overhead estimate unit, copying the unit's hours.

A model then rewrites the section bodies, or names the modules and screens. It
cannot add a section, change a number, cite a requirement it was not given, or
invent a source location. Those are properties of the schemas in
`document-schemas.ts`, not of the prompts.

## Edit protection

A section's `origin` is `GENERATED`, `USER_EDITED` or `USER_AUTHORED`. Regeneration
replaces the first and _proposes_ over the other two: the body stays, the new text
lands in `proposedBody`, and a pending proposal is a blocker. Resolving it keeps the
section protected whichever option was chosen — accepting a rewrite is still a
person's decision, and the next regeneration must ask again.

Feature rows are matched across regenerations on the estimate unit behind them,
which is a row's identity. Descriptive edits carry forward; hours always come from
the new composition, because they come from the estimate.

## Storage

Five collections. `documents` holds current state and the assessment approval reads.
`document_sections` and `document_features` are per-row, so editing one paragraph is
a small write with its own optimistic concurrency. `document_versions` holds
immutable snapshots — the one place content is denormalised, and the place where
that is correct. `document_generation_runs` and `document_validation_results` are
records: sizes, timings, prompt versions, severities. Never requirement text, never
a prompt, never document prose.

A document is never embedded in the project record. Seven documents with fifteen
sections and up to two thousand rows would make every unrelated project read
expensive.

The repository stamps `projectId` and `type` onto section and feature rows itself
rather than trusting callers — every row in those collections is scoped by them, and
a caller that forgets writes a section belonging to nothing.

## Reading is recomputing

`assemble` recomputes outdatedness, coverage, reconciliation, blockers and the
effective status on every read, exactly as Phase 6 does with the estimate. All of
them are functions of stored data and the current upstream state, and storing them
without recomputing is how a stale "everything is fine" survives a change upstream.

An approved document whose inputs have moved reports `OUTDATED` without its stored
status being rewritten, so the transition cannot be missed by a job that did not run.

## Validation

Deterministic findings are authoritative. `MODEL_RAISABLE_KINDS` limits a model to
four judgement kinds, and every model finding is a `WARNING` labelled
`detectedBy: 'MODEL'`. Approval requires a validation result belonging to the
_current_ version with no blocking finding — ADR-0034.

`PASS` findings are kept. "Coverage is complete" and "the hours match the estimate"
are the two things a reviewer most wants confirmed, and an empty list confirms
nothing.

## Working without a model

`AI_PROVIDER=disabled` is a supported configuration. Generation, section rewriting,
validation and approval all work; the prose is plainer. `DocumentsAiService` takes
the provider `@Optional()`, so the module starts normally with none, and
`useAi: false` is a first-class request rather than a fallback.

## Known limitations

- **Five of seven documents are declared, not implemented.** They are visible and
  marked unavailable; nothing can generate, read or approve them.
- **Export is Phase 11.** Copy-to-clipboard and the strict CSV serialisation exist
  because the CSV schema is a Phase 7 requirement. DOCX, PDF and XLSX do not.
- **The deterministic module and screen names are crude** — derived from the
  requirement's own words. A model does this far better; what matters is that the
  fallback is derived rather than invented.
- **The forbidden-content list is a denylist**, and a denylist is never complete. It
  catches the phrases this failure mode actually produces; the general defence is
  that a section may only cite requirements it was given.
