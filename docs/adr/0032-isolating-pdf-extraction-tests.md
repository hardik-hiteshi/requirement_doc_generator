# 32. PDF extraction tests get a process of their own

Date: 2026-08-10

Status: Accepted

## Context

pdfjs is ESM-only, and the API compiles to CommonJS. A literal `import()` is
rewritten to `require()` by the transpiler, which cannot load an ES module, so
`pdf-extractor.ts` builds the import out of reach of the compiler:

```ts
const importEsm = new Function('specifier', 'return import(specifier)');
```

In production this is unremarkable: one process, one application, for the
lifetime of the deployment. Under Jest it is not. A function built that way has
no module referrer, so Jest cannot attribute the import to the file that made it
and falls back to the runtime it registered most recently. For the second and
later suites in a worker process, that runtime belongs to the _previous_ suite —
which Jest has already torn down. The import then fails with:

```
ReferenceError: You are trying to `import` a file after the Jest environment
has been torn down. From test/conflict-reevaluation.e2e-spec.ts.
```

The visible symptom is nothing to do with PDFs. The extraction job is requeued
with backoff, the source sits at `QUEUED`, and a test asserting `READY` fails —
in the suite that happens to run second, on the machine that happens to schedule
it that way. It passed locally for exactly that reason and failed in hosted CI.

Two things were tried and rejected before this.

**Retry the import after a reload.** `pdfjsGeneration` cache-busts the specifier
so Node loads a fresh copy of the module, which is the right answer for a
_disposed_ pdfjs in a long-lived process. It cannot help here: the import
mechanism itself is dead, not the module it would load.

**Order the suites so the PDF one runs first.** This worked, and it made
correctness depend on run order. Adding a suite, reordering by timing cache, or
sharding differently would all reintroduce the failure silently.

## Decision

**The suite that extracts PDFs is a Jest project of its own, containing exactly
one test file.**

- `jest.e2e.config.ts` — every integration suite except that one, two workers,
  fixed path order.
- `jest.pdf.config.ts` — `pdf-extraction.e2e-spec.ts` and nothing else, one
  worker.
- `pnpm test:e2e` runs both. CI runs them as separate steps, so a PDF failure is
  never mistaken for a general integration failure, and so PDF verification is
  visibly present rather than implied.

One file in its own process means no environment has been created — and
therefore none torn down — before the import happens. The runtime Jest falls back
to is the suite's own. Nothing can be scheduled before it, so nothing about
ordering, sharding or how many suites exist later can affect it.

**Every PDF lives in that file**, including uploads that are rejected at
validation and never extracted. An accepted PDF upload leaves a queued job in a
database every suite shares, and the next `drainWorker` anywhere claims it —
which would put the import back into a shared process by a route nobody would
think to look for.

**The invariant is tested, not documented.**
`test/test-topology.e2e-spec.ts` reads the two configuration objects and the
fixtures directory and asserts: the PDF project resolves to exactly one file,
that file is absent from the main project, every spec belongs to exactly one
project, no main-project spec mentions any `.pdf` fixture, and the PDF project is
pinned to one worker.

`test/sequencer.cjs` stays, and its comment now says what it is for: fixed order
makes a shared-database contention failure reproducible. `E2E_ORDER=reverse` runs
the main suites back to front, and CI does exactly that once per run — the claim
"order does not matter" is checked rather than asserted.

## Consequences

`pnpm test:e2e` prints two summaries, and the integration total is their sum.
Anyone reading CI sees two steps where there was one.

The shared bootstrap and upload helpers moved to `test/ingestion-harness.ts`
rather than being duplicated across the two files.

`maxWorkers: 1` on the PDF project is a statement, not a mitigation: with one
test file there is nothing to parallelise, and pinning it records that the
process belongs to this suite alone.

The underlying constraint is unchanged — pdfjs remains a process-level ESM import
reached through `new Function`. What has changed is that no test's outcome depends
on where it lands in a run. If a CommonJS build of pdfjs with page-level
positioning ever exists, or the API's module target changes so a real dynamic
`import()` survives compilation, both this split and the `new Function` can go.
