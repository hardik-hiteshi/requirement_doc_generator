/**
 * Injection tokens for the outbound ports.
 *
 * Symbols rather than strings so two packages cannot collide on the same token
 * name, and so a typo fails at compile time instead of at runtime.
 *
 * No token is bound to a provider in Phase 1 — see `./README.md`.
 */
export const AI_PROVIDER_PORT = Symbol('AiProviderPort');
export const FILE_STORAGE_PORT = Symbol('FileStoragePort');
export const JOB_QUEUE_PORT = Symbol('JobQueuePort');
export const FILE_EXTRACTION_PORT = Symbol('FileExtractionPort');
export const DOCUMENT_EXPORT_PORT = Symbol('DocumentExportPort');
