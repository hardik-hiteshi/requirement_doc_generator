# Ports

This directory holds the outbound boundaries of the application: the interfaces
the domain depends on, plus the injection tokens used to bind an implementation.

**Nothing here is implemented yet.** Phase 1 defines the contracts only. Each
port names the phase that will supply its first adapter. No token is registered
in any module, so an accidental injection fails at bootstrap with a clear
"no provider" error rather than silently resolving to a stub that returns
plausible-looking fake data.

## Why the boundaries exist now

Retro-fitting these seams after the business logic is written is the expensive
kind of rework: services end up importing an SDK directly, and swapping the
provider (or testing without it) means touching every call site. Declaring the
interface first costs nothing and fixes the dependency direction — the domain
owns the interface, the adapter conforms to it.

## The ports

| Port                 | Owns                                                                       | First adapter                          |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| `AiProviderPort`     | Structured, schema-validated model calls against **self-hosted** inference | Phase 4 (Ollama / vLLM — ADR-0017)     |
| `FileStoragePort`    | Private object storage with authorized reads                               | Phase 3 (local FS, then S3-compatible) |
| `JobQueuePort`       | Asynchronous, resumable, idempotent work                                   | Phase 3                                |
| `FileExtractionPort` | Text/table/OCR extraction with source traceability                         | Phase 3                                |
| `DocumentExportPort` | Validated structured content to DOCX/PDF/CSV/XLSX                          | Phase 11                               |

## Rules

1. A port describes **what the domain needs**, never what a vendor offers. If an
   interface mirrors an SDK's method names, it is an SDK wrapper, not a port.
2. Ports are free of framework types. No `Request`, no Mongoose documents, no
   Nest decorators.
3. Errors are part of the contract. A port declares the failure modes callers
   must handle; adapters translate vendor errors into them.
4. Every adapter is registered through its token in a feature module, so tests
   substitute a fake by overriding the token.
