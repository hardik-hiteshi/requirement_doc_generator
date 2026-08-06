/**
 * Injection tokens for the outbound ports.
 *
 * Symbols rather than strings so two packages cannot collide on the same token
 * name, and so a typo fails at compile time instead of at runtime.
 *
 * Phase 3 binds `FILE_STORAGE_PORT`, `JOB_QUEUE_PORT`, `FILE_EXTRACTION_PORT`,
 * `OCR_PROVIDER_PORT` and `LEGACY_CONVERSION_PORT`. The AI and document-export
 * tokens remain unbound until their phases — see `./README.md`.
 */
export const AI_PROVIDER_PORT = Symbol('AiProviderPort');
export const FILE_STORAGE_PORT = Symbol('FileStoragePort');
export const JOB_QUEUE_PORT = Symbol('JobQueuePort');
export const FILE_EXTRACTION_PORT = Symbol('FileExtractionPort');
export const DOCUMENT_EXPORT_PORT = Symbol('DocumentExportPort');

/* Phase 3 additions. */
export const OCR_PROVIDER_PORT = Symbol('OcrProviderPort');
export const LEGACY_CONVERSION_PORT = Symbol('LegacyConversionPort');
