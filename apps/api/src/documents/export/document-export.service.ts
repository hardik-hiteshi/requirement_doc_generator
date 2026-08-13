import { Injectable } from '@nestjs/common';
import {
  accentOrNeutral,
  brandingIdentity,
  contentDisposition,
  DOCUMENT_STATUS_LABELS,
  EXPORT_MIME_TYPES,
  exportFilename,
  isFormatAllowed,
  looksLikeSecret,
  PROJECT_DOCUMENT_LABELS,
  type Branding,
  type DocumentSnapshot,
  type ExportFormat,
  type ProjectDocument,
} from '@wdrg/contracts';

import { AuditService } from '../../audit/audit.service';
import { DOCUMENT_ERROR_CODES } from '@wdrg/contracts';

import { DocumentError } from '../documents.errors';
import { DocumentsService, type DocumentContext } from '../documents.service';
import { proseProjection, tableProjection } from './document-projections';
import { exportMetadata } from './export-projection';
import { renderCsv } from './renderers/csv.renderer';
import { renderDocx } from './renderers/docx.renderer';
import { renderPdf } from './renderers/pdf.renderer';
import { renderXlsx } from './renderers/xlsx.renderer';

/**
 * Turning a stored document version into a file, and nothing else.
 *
 * Read-derived from end to end. This service selects a snapshot, projects it and renders
 * it — it never generates, validates, approves, reopens, restores or reconciles anything.
 * A download that changed the document it downloaded would be a trap, and an export that
 * "helpfully" regenerated stale content would quietly replace the thing somebody asked
 * for with something else.
 *
 * The version comes from `DocumentsService`: the working one by default, an archived one
 * when asked. Both arrive as the same snapshot shape, so nothing downstream has to know
 * which it got — and neither path reconstructs old content from current state.
 */

/** What a renderer may be handed. Kept small so a logo cannot become a path. */
export interface ExportLogo {
  readonly content: Buffer;
  readonly contentType: 'image/png' | 'image/jpeg';
}

export interface ExportResult {
  readonly content: Buffer;
  readonly contentType: string;
  readonly filename: string;
  readonly disposition: string;
  readonly byteLength: number;
  readonly documentVersion: number;
}

/**
 * A ceiling on what a renderer may hand back.
 *
 * Not rate limiting — that is a later phase. This is the narrower question of a single
 * render producing something absurd, which is a bug rather than abuse, and is better
 * reported than streamed.
 */
const MAX_EXPORT_BYTES = 40 * 1024 * 1024;

@Injectable()
export class DocumentExportService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  async export(input: {
    readonly context: DocumentContext;
    readonly document: ProjectDocument;
    readonly format: ExportFormat;
    readonly version?: number;
    readonly projectName: string;
    readonly branding: Branding | undefined;
    readonly logo?: ExportLogo;
  }): Promise<ExportResult> {
    const { context, document, format } = input;

    /* The matrix decides, and it is the one the preferences screen already showed. */
    if (!isFormatAllowed(document, format)) {
      await this.record('DOCUMENT_EXPORT_FAILED', input, { reason: 'unsupported_format' });

      throw new DocumentError(DOCUMENT_ERROR_CODES.UNSUPPORTED_EXPORT_FORMAT, 422, undefined, {
        documentType: document,
        format,
      });
    }

    await this.record('DOCUMENT_EXPORT_REQUESTED', input, {});

    const snapshot = await this.snapshotFor(context, document, input.version);
    const exportedAt = new Date();

    const metadata = exportMetadata({
      snapshot,
      document,
      projectName: input.projectName,
      branding: input.branding,
      exportedAt,
    });

    /*
     * A last look before the bytes leave.
     *
     * The document model has no field for a credential, and Phase 9 refuses one on the way
     * in — so anything secret-shaped here came from data that predates that rule or was
     * corrupted. Failing closed is the only safe answer: a redacted client document is a
     * conversation, a leaked key is an incident.
     */
    this.refuseSecrets(snapshot, document);

    let content: Buffer;

    try {
      content = await this.render({ ...input, snapshot, metadata });
    } catch {
      await this.record('DOCUMENT_EXPORT_FAILED', input, {
        reason: 'render_failed',
        documentVersion: snapshot.version,
      });

      /* 503: the document is fine, the renderer was not. Retrying is reasonable. */
      throw new DocumentError(DOCUMENT_ERROR_CODES.EXPORT_RENDER_FAILED, 503, undefined, {
        documentType: document,
        format,
      });
    }

    if (content.byteLength > MAX_EXPORT_BYTES) {
      await this.record('DOCUMENT_EXPORT_FAILED', input, {
        reason: 'too_large',
        byteLength: content.byteLength,
      });

      throw new DocumentError(DOCUMENT_ERROR_CODES.EXPORT_TOO_LARGE, 422);
    }

    const filename = exportFilename({
      projectName: input.projectName,
      document,
      format,
      version: snapshot.version,
      ...(snapshot.status === 'FINAL' ? { lifecycleLabel: DOCUMENT_STATUS_LABELS.FINAL } : {}),
    });

    await this.audit.record({
      type: 'DOCUMENT_EXPORTED',
      projectId: context.projectId,
      correlationId: context.correlationId,
      metadata: {
        documentType: document,
        format,
        documentVersion: snapshot.version,
        status: snapshot.status,
        currentness: snapshot.currentness,
        byteLength: content.byteLength,
        /* Whether branding was applied, never what it said. */
        branded: brandingIdentity(input.branding) !== 'default',
      },
    });

    return {
      content,
      contentType: EXPORT_MIME_TYPES[format],
      filename,
      disposition: contentDisposition(filename),
      byteLength: content.byteLength,
      documentVersion: snapshot.version,
    };
  }

  /**
   * The exact version asked for, or the working one.
   *
   * `DocumentsService.version()` returns the archived snapshot as it stood, which is what
   * makes historical export honest — there is no replaying of edits and no reaching for
   * current content when an old version is wanted.
   */
  private async snapshotFor(
    context: DocumentContext,
    document: ProjectDocument,
    version: number | undefined,
  ): Promise<DocumentSnapshot> {
    if (version === undefined) {
      const snapshot = await this.documents.read(context, document);

      /*
       * A document nobody has written cannot be exported. It reports the version it would
       * be written as, which is why this asks the status rather than trusting the number.
       */
      if (snapshot.status === 'NOT_STARTED') {
        throw new DocumentError(DOCUMENT_ERROR_CODES.DOCUMENT_NOT_GENERATED, 422);
      }

      return snapshot;
    }

    try {
      return await this.documents.version(context, document, version);
    } catch (error) {
      if (
        error instanceof DocumentError &&
        error.documentCode === DOCUMENT_ERROR_CODES.DOCUMENT_NOT_FOUND
      ) {
        /*
         * An unknown version and somebody else's version answer identically, so a caller
         * cannot use export to discover which versions exist in another project.
         */
        throw new DocumentError(DOCUMENT_ERROR_CODES.EXPORT_VERSION_NOT_FOUND, 404);
      }

      throw error;
    }
  }

  private async render(input: {
    readonly format: ExportFormat;
    readonly document: ProjectDocument;
    readonly snapshot: DocumentSnapshot;
    readonly metadata: ReturnType<typeof exportMetadata>;
    readonly projectName: string;
    readonly branding: Branding | undefined;
    readonly logo?: ExportLogo;
  }): Promise<Buffer> {
    const accentColor = accentOrNeutral(input.branding);

    switch (input.format) {
      case 'CSV':
        return renderCsv(tableProjection(input.document, input.snapshot));
      case 'XLSX':
        return renderXlsx({
          projection: tableProjection(input.document, input.snapshot),
          metadata: input.metadata,
          accentColor,
        });
      case 'DOCX':
        return renderDocx({
          projection: this.prose(input),
          metadata: input.metadata,
          accentColor,
          ...(input.logo ? { logo: input.logo } : {}),
        });
      case 'PDF':
        return renderPdf({
          projection: this.prose(input),
          metadata: input.metadata,
          accentColor,
          ...(input.logo ? { logo: input.logo } : {}),
        });
    }
  }

  private prose(input: {
    readonly document: ProjectDocument;
    readonly snapshot: DocumentSnapshot;
    readonly projectName: string;
    readonly branding: Branding | undefined;
    readonly metadata: ReturnType<typeof exportMetadata>;
  }): ReturnType<typeof proseProjection> {
    return proseProjection({
      document: input.document,
      snapshot: input.snapshot,
      projectName: input.projectName,
      branding: input.branding,
      exportedAt: new Date(input.metadata.exportedAt),
    });
  }

  /**
   * A last look before the bytes leave, aimed where a credential could plausibly be.
   *
   * Phase 9's rule is about the client dependency sheet: a credential must be recorded as
   * metadata — "we need the API key, sent separately" — and never as row text. The model
   * has no field for a value, and the write path refuses one, so anything found here came
   * from data that predates that rule or was corrupted.
   *
   * Scoped to that document's free-text fields rather than every string on every row. A
   * blanket scan is worse than no scan: `looksLikeSecret` includes a pattern for long
   * base64-ish runs, which ordinary content can trip, and an export that refuses a valid
   * document teaches people to route around the check.
   */
  private refuseSecrets(snapshot: DocumentSnapshot, document: ProjectDocument): void {
    if (document !== 'CLIENT_DEPENDENCY_SHEET') {
      return;
    }

    const TEXT_FIELDS = [
      'dependency',
      'description',
      'purpose',
      'remarks',
      'validationNote',
      'expectedFormat',
      'impactIfDelayed',
    ] as const;

    const found = snapshot.rows.some((row) => {
      const payload = row.payload as Record<string, unknown>;

      return TEXT_FIELDS.some((field) => {
        const value = payload[field];

        /* `looksLikeSecret` answers with labels; an empty list means nothing matched. */
        return typeof value === 'string' && looksLikeSecret(value).length > 0;
      });
    });

    if (found) {
      throw new DocumentError(DOCUMENT_ERROR_CODES.EXPORT_CONTENT_REFUSED, 422, undefined, {
        documentType: document,
        /* Says that something was refused. Never what, and never the value. */
        reason: 'credential_shaped_value',
      });
    }
  }

  private async record(
    type: 'DOCUMENT_EXPORT_REQUESTED' | 'DOCUMENT_EXPORT_FAILED',
    input: {
      readonly context: DocumentContext;
      readonly document: ProjectDocument;
      readonly format: ExportFormat;
      readonly version?: number;
    },
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      type,
      projectId: input.context.projectId,
      correlationId: input.context.correlationId,
      metadata: {
        documentType: input.document,
        documentLabel: PROJECT_DOCUMENT_LABELS[input.document],
        format: input.format,
        ...(input.version !== undefined ? { requestedVersion: input.version } : {}),
        ...extra,
      },
    });
  }
}
