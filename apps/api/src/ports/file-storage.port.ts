/**
 * Outbound boundary for binary storage.
 *
 * First adapter: Phase 3 (local filesystem for development, S3-compatible for
 * production).
 *
 * Uploaded files are never public. Objects are addressed by an opaque key the
 * application mints — never by a client-supplied filename — which is what makes
 * path traversal impossible rather than merely guarded against.
 */

export interface StoredObjectKey {
  /** Namespace, always the owning project. Enforces per-project isolation. */
  readonly projectId: string;
  /** Opaque, application-generated identifier. Never a client filename. */
  readonly objectId: string;
}

export interface StoredObjectMetadata {
  readonly key: StoredObjectKey;
  readonly sizeBytes: number;
  /** MIME type as verified by content inspection, not as claimed by the client. */
  readonly contentType: string;
  /** SHA-256 of the content, for integrity checks and duplicate detection. */
  readonly checksumSha256: string;
  readonly createdAt: Date;
}

export interface PutObjectRequest {
  readonly key: StoredObjectKey;
  readonly content: Buffer | NodeJS.ReadableStream;
  readonly contentType: string;
  /** Original filename, stored as metadata only — never used as a path. */
  readonly originalFilename?: string;
}

export interface SignedDownload {
  readonly url: string;
  readonly expiresAt: Date;
}

export type StorageFailureReason =
  'not_found' | 'quota_exceeded' | 'unavailable' | 'integrity_mismatch';

export class FileStorageError extends Error {
  constructor(
    public readonly reason: StorageFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FileStorageError';
  }
}

export interface FileStoragePort {
  put(request: PutObjectRequest): Promise<StoredObjectMetadata>;

  /** Streams an object. Authorization is the caller's responsibility. */
  getStream(key: StoredObjectKey): Promise<NodeJS.ReadableStream>;

  head(key: StoredObjectKey): Promise<StoredObjectMetadata>;

  /**
   * Issues a short-lived, authorized download URL.
   *
   * Implementations that cannot sign (local filesystem) return a URL routed back
   * through the API, so authorization is enforced identically either way.
   */
  createSignedDownload(key: StoredObjectKey, ttlSeconds: number): Promise<SignedDownload>;

  delete(key: StoredObjectKey): Promise<void>;

  /** Removes every object for a project. Used by retention and manual deletion. */
  deleteProject(projectId: string): Promise<void>;
}
