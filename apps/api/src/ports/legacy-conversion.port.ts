/**
 * Outbound boundary for converting legacy binary office formats.
 *
 * First adapter: Phase 3 (headless LibreOffice), **disabled by default**.
 *
 * `.doc` and `.xls` are pre-2007 binary formats with no readable structure short
 * of reimplementing a decade of Microsoft's file layout. The only realistic
 * converter is an office suite, which is a several-hundred-megabyte dependency —
 * and acquiring one as a side effect of installing this application would be a
 * decision made on a deployment's behalf that it never asked for.
 *
 * So the boundary exists, an adapter exists behind it, and it is off unless
 * configured. Where it is off, legacy files are refused with an explanation
 * naming the fix. What must never happen is claiming support that is not there:
 * a user who is told `.doc` works and finds it silently produced nothing has
 * been lied to by the product.
 */

export type LegacyFormat = 'doc' | 'xls';

export interface LegacyConversionRequest {
  readonly format: LegacyFormat;
  readonly content: Buffer;
  /** For logging and temporary filenames only. Never used to build a path. */
  readonly filename: string;
}

export interface LegacyConversionResult {
  /** The converted bytes: `.docx` for `.doc`, `.xlsx` for `.xls`. */
  readonly content: Buffer;
  /** Extension of the produced file, so the right extractor is chosen. */
  readonly extension: 'docx' | 'xlsx';
  readonly durationMs: number;
  readonly converter: string;
}

export type LegacyConversionFailureReason =
  | 'not_configured'
  | 'converter_unavailable'
  | 'unsupported_format'
  | 'corrupted_file'
  | 'password_protected'
  | 'timeout'
  | 'conversion_failed';

export class LegacyConversionError extends Error {
  constructor(
    public readonly reason: LegacyConversionFailureReason,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LegacyConversionError';
  }
}

export interface LegacyConversionPort {
  /**
   * Whether conversion is configured *and* the converter actually runs.
   *
   * Both halves matter. A deployment that enabled conversion but has no binary
   * installed must find out at startup, not when a user uploads a file.
   */
  isAvailable(): Promise<boolean>;

  /** @throws {LegacyConversionError} for every failure mode above. */
  convert(request: LegacyConversionRequest): Promise<LegacyConversionResult>;
}
