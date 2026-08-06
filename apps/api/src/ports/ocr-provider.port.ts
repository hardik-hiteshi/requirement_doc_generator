/**
 * Outbound boundary for optical character recognition.
 *
 * First adapter: Phase 3 (Tesseract, invoked as a local binary).
 *
 * OCR is behind a port for a reason that is not abstraction for its own sake:
 * the realistic alternatives — a local engine, a cloud vision API — differ in
 * accuracy, cost, latency and, decisively, in whether a client's requirement
 * documents leave the building. That is a deployment decision, and it should be
 * a configuration change rather than a rewrite.
 *
 * **Confidence is part of the contract, not a detail.** An OCR result without a
 * confidence score cannot be reviewed intelligently: the reader has no way to
 * know which words to check. Every implementation must report it, per word or
 * per region, and callers must treat a low score as "a human has to look at
 * this" rather than as a number to average into insignificance.
 */

export interface OcrRegion {
  readonly text: string;
  /** 0–1. What the engine thinks of *this* text, not of the page. */
  readonly confidence: number;
  /** Pixel bounds, when the engine reports them. */
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** 1-based, for multi-page input. */
  readonly pageNumber?: number;
}

export interface OcrResult {
  readonly text: string;
  /** Mean confidence across recognised words, weighted by nothing. */
  readonly meanConfidence: number;
  readonly regions: readonly OcrRegion[];
  /** Rotation the engine applied, in degrees, if it corrected orientation. */
  readonly appliedRotation?: number;
  readonly durationMs: number;
  readonly engine: string;
}

export interface OcrRequest {
  readonly content: Buffer;
  /** Extension of the image, so an adapter can pick a decoder. */
  readonly format: string;
  /** Engine language codes, e.g. `eng` or `eng+deu`. */
  readonly languages: string;
  /** Correct page orientation before recognising, where the engine can. */
  readonly detectOrientation: boolean;
  readonly pageNumber?: number;
}

export type OcrFailureReason =
  'engine_unavailable' | 'unsupported_image' | 'timeout' | 'engine_error';

export class OcrError extends Error {
  constructor(
    public readonly reason: OcrFailureReason,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OcrError';
  }
}

export interface OcrProviderPort {
  /** Whether the engine is actually usable right now. Checked at startup. */
  isAvailable(): Promise<boolean>;

  /** @throws {OcrError} for every failure mode above. */
  recognise(request: OcrRequest): Promise<OcrResult>;

  /**
   * What this engine cannot do reliably, in plain language.
   *
   * Surfaced in the UI and the documentation. An engine that is poor at
   * handwriting should say so where a user can read it, rather than returning
   * confident nonsense and leaving them to discover it in a signed document.
   */
  limitations(): readonly string[];
}
