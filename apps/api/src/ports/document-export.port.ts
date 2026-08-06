/**
 * Outbound boundary for rendering approved documents into deliverable files.
 *
 * First adapter: Phase 11.
 *
 * The AI never produces binary output. It produces structured JSON, the domain
 * validates it, and an exporter renders it. That separation is what allows the
 * pre-export validation gate (feature totals matching the WBS, CSV column order,
 * formula-injection neutralisation) to run against data rather than bytes.
 */

export type ExportFormat = 'docx' | 'pdf' | 'csv' | 'xlsx';

export type ExportableDocument =
  | 'our-understanding'
  | 'feature-listing'
  | 'acceptance-criteria'
  | 'assumptions'
  | 'statement-of-work'
  | 'work-breakdown-structure'
  | 'client-dependency-sheet';

/** Optional branding. Absent values are omitted, never replaced with filler. */
export interface DocumentBranding {
  readonly companyName?: string;
  readonly clientName?: string;
  readonly projectName?: string;
  readonly logo?: { readonly content: Buffer; readonly contentType: string };
  readonly headerText?: string;
  readonly footerText?: string;
  readonly documentVersion?: string;
  readonly preparedBy?: string;
  readonly preparedDate?: Date;
  readonly confidentialityLabel?: string;
}

export interface ExportRequest<TContent = unknown> {
  readonly document: ExportableDocument;
  readonly format: ExportFormat;
  /** Structured content, already validated against the document's schema. */
  readonly content: TContent;
  readonly branding?: DocumentBranding;
  readonly correlationId: string;
}

export interface ExportArtifact {
  readonly content: Buffer;
  readonly contentType: string;
  /** Suggested filename. Sanitised by the adapter, never client-supplied. */
  readonly filename: string;
  readonly byteLength: number;
  readonly durationMs: number;
}

export type ExportFailureReason =
  | 'unsupported_combination' // Document/format pair is not offered.
  | 'invalid_content' // Content did not satisfy the document schema.
  | 'render_failed'
  | 'too_large';

export class DocumentExportError extends Error {
  constructor(
    public readonly reason: ExportFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DocumentExportError';
  }
}

export interface DocumentExportPort {
  /** Formats offered for a document, driving what the UI can present. */
  supportedFormats(document: ExportableDocument): readonly ExportFormat[];

  /** @throws {DocumentExportError} for every failure mode above. */
  export(request: ExportRequest): Promise<ExportArtifact>;
}
