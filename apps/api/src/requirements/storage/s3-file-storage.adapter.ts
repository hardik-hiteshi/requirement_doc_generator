import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Client as MinioClient } from 'minio';

import { AppConfigService } from '../../config/app-config.service';
import {
  FileStorageError,
  type FileStoragePort,
  type PutObjectRequest,
  type SignedDownload,
  type StoredObjectKey,
  type StoredObjectMetadata,
} from '../../ports';

/**
 * `FileStoragePort` over an S3-compatible server you run yourself.
 *
 * **No cloud account is involved.** S3 here is a wire protocol, not a vendor:
 * the compose stack runs MinIO, and the same adapter works against Ceph RGW,
 * Garage, SeaweedFS or anything else that speaks it. There is no default
 * endpoint, so a misconfigured deployment fails at startup rather than quietly
 * reaching for someone's cloud.
 *
 * The security properties are the same as the filesystem adapter's, and for the
 * same reasons:
 *
 * - **Object keys are minted, never client-supplied.** `<projectId>/<objectId>`,
 *   both application-generated, so a filename cannot influence where anything
 *   lands. The key prefix also gives per-project isolation for free.
 * - **The bucket is private.** Nothing is readable without credentials the
 *   application holds and never discloses.
 * - **A key is not a credential.** Keys are never returned by any endpoint, and
 *   possessing one grants nothing: reads go through the API's own authorized
 *   route, which checks the session first.
 *
 * Presigned URLs are supported and deliberately not used by the download path.
 * A presigned URL is a bearer token in a query string — it outlives the check
 * that produced it, appears in logs and `Referer` headers, and cannot be
 * revoked. Streaming through the API costs a hop and keeps authorization in one
 * place. The method exists for callers that genuinely need to hand a URL to
 * something outside the request, and it is issued only after authorization.
 */
@Injectable()
export class S3FileStorageAdapter implements FileStoragePort, OnModuleInit {
  private readonly logger = new Logger(S3FileStorageAdapter.name);
  private client: MinioClient | undefined;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Verifies the bucket exists and is reachable, at startup.
   *
   * Storage that is only discovered to be broken on the first upload has
   * already cost a user their file and their patience.
   */
  async onModuleInit(): Promise<void> {
    if (this.config.upload.adapter !== 's3') {
      return;
    }

    const s3 = this.config.s3;

    try {
      const exists = await this.minio().bucketExists(s3.bucket);

      if (!exists) {
        throw new FileStorageError(
          'unavailable',
          `The storage bucket "${s3.bucket}" does not exist. Create it on your storage server before starting.`,
        );
      }

      this.logger.log(
        { endpoint: `${s3.endpoint}:${s3.port}`, bucket: s3.bucket },
        'Object storage reachable',
      );
    } catch (cause) {
      if (cause instanceof FileStorageError) {
        throw cause;
      }

      // Credentials must not reach a log line, so only the endpoint is named.
      this.logger.error(
        { endpoint: `${s3.endpoint}:${s3.port}`, bucket: s3.bucket, cause: describe(cause) },
        'Object storage is not reachable',
      );

      throw new FileStorageError(
        'unavailable',
        'The configured object storage is not reachable. Check the endpoint, the bucket and the credentials.',
        { cause },
      );
    }
  }

  async put(request: PutObjectRequest): Promise<StoredObjectMetadata> {
    const content = await toBuffer(request.content);
    const key = objectKey(request.key);

    try {
      await this.minio().putObject(this.config.s3.bucket, key, content, content.length, {
        'Content-Type': request.contentType,
        // The project id, so an operator inspecting the bucket can attribute an
        // object without a database lookup. The *filename* is deliberately not
        // stored as metadata: it is client-supplied text, and object metadata is
        // returned in headers.
        'x-amz-meta-project-id': request.key.projectId,
      });
    } catch (cause) {
      this.logger.error({ cause: describe(cause) }, 'Object storage write failed');
      throw new FileStorageError('unavailable', 'The file could not be stored.', { cause });
    }

    return {
      key: request.key,
      sizeBytes: content.length,
      contentType: request.contentType,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
      createdAt: new Date(),
    };
  }

  async getStream(key: StoredObjectKey): Promise<Readable> {
    try {
      return await this.minio().getObject(this.config.s3.bucket, objectKey(key));
    } catch (cause) {
      throw this.mapReadFailure(cause, key);
    }
  }

  async head(key: StoredObjectKey): Promise<StoredObjectMetadata> {
    try {
      const stat = await this.minio().statObject(this.config.s3.bucket, objectKey(key));

      return {
        key,
        sizeBytes: stat.size,
        // minio types metaData loosely; narrow before use rather than letting
        // an `any` flow into a response.
        contentType: readContentType(stat.metaData),
        // The stored ETag is not a SHA-256 — for a multipart upload it is not
        // even a hash of the content. Reporting it as one would be a lie a
        // caller could act on, so integrity is checked against the checksum the
        // source record holds.
        checksumSha256: '',
        createdAt: stat.lastModified,
      };
    } catch (cause) {
      throw this.mapReadFailure(cause, key);
    }
  }

  async exists(key: StoredObjectKey): Promise<boolean> {
    try {
      await this.minio().statObject(this.config.s3.bucket, objectKey(key));
      return true;
    } catch (cause) {
      if (isNotFound(cause)) {
        return false;
      }

      // A network failure is not an answer. Reporting "no" here would let a
      // cleanup job conclude there was nothing to remove.
      throw new FileStorageError('unavailable', 'The object store could not be reached.', {
        cause,
      });
    }
  }

  /**
   * Issues a short-lived presigned URL from the self-hosted server.
   *
   * Only ever called after the caller's session has been verified. The TTL is
   * configured and bounded, because a presigned URL cannot be revoked once
   * issued — the only control over its lifetime is how long it was minted for.
   */
  async createSignedDownload(key: StoredObjectKey, ttlSeconds: number): Promise<SignedDownload> {
    const ttl = Math.min(ttlSeconds, this.config.s3.signedUrlTtlSeconds);

    try {
      const url = await this.minio().presignedGetObject(this.config.s3.bucket, objectKey(key), ttl);

      return { url, expiresAt: new Date(Date.now() + ttl * 1_000) };
    } catch (cause) {
      throw new FileStorageError('unavailable', 'A download link could not be issued.', { cause });
    }
  }

  async delete(key: StoredObjectKey): Promise<void> {
    try {
      await this.minio().removeObject(this.config.s3.bucket, objectKey(key));
    } catch (cause) {
      if (isNotFound(cause)) {
        // Already gone is the outcome the caller wanted.
        return;
      }

      throw new FileStorageError('unavailable', 'The file could not be removed.', { cause });
    }
  }

  /**
   * Removes every object for a project.
   *
   * Listed and removed by prefix, which is what the `<projectId>/` key layout is
   * for: deleting a project is one prefix scan rather than a lookup per file.
   */
  async deleteProject(projectId: string): Promise<void> {
    assertOpaque(projectId, 'projectId');

    const bucket = this.config.s3.bucket;
    const keys: string[] = [];

    try {
      const stream = this.minio().listObjectsV2(bucket, `${projectId}/`, true);

      for await (const item of stream as AsyncIterable<{ name?: string }>) {
        if (item.name) {
          keys.push(item.name);
        }
      }

      if (keys.length > 0) {
        await this.minio().removeObjects(bucket, keys);
      }
    } catch (cause) {
      this.logger.error({ projectId, cause: describe(cause) }, 'Project cleanup failed');
      throw new FileStorageError('unavailable', "The project's files could not be removed.", {
        cause,
      });
    }
  }

  /** Built lazily so a filesystem deployment never constructs a storage client. */
  private minio(): MinioClient {
    if (this.client) {
      return this.client;
    }

    const s3 = this.config.s3;

    if (s3.endpoint.trim().length === 0 || s3.bucket.trim().length === 0) {
      throw new FileStorageError(
        'unavailable',
        'Object storage is selected but not configured. Set S3_ENDPOINT and S3_BUCKET.',
      );
    }

    this.client = new MinioClient({
      endPoint: s3.endpoint,
      port: s3.port,
      useSSL: s3.useSsl,
      accessKey: s3.accessKey,
      secretKey: s3.secretKey,
      region: s3.region,
    });

    return this.client;
  }

  private mapReadFailure(cause: unknown, key: StoredObjectKey): FileStorageError {
    if (isNotFound(cause)) {
      return new FileStorageError('not_found', `No stored object ${key.objectId}.`, { cause });
    }

    this.logger.error({ cause: describe(cause) }, 'Object storage read failed');
    return new FileStorageError('unavailable', 'The stored file could not be read.', { cause });
  }
}

/**
 * `<projectId>/<objectId>`.
 *
 * Both components are application-minted and validated here. If either ever
 * contains anything else, something upstream has started passing user input
 * where an identifier belongs, and it should fail loudly rather than build a key.
 */
export function objectKey(key: StoredObjectKey): string {
  assertOpaque(key.projectId, 'projectId');
  assertOpaque(key.objectId, 'objectId');

  return `${key.projectId}/${key.objectId}`;
}

function assertOpaque(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new FileStorageError(
      'not_found',
      `Refusing to build an object key from an unsafe ${label}.`,
    );
  }
}

function readContentType(metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null) {
    return 'application/octet-stream';
  }

  const value = (metadata as Record<string, unknown>)['content-type'];

  return typeof value === 'string' && value.length > 0 ? value : 'application/octet-stream';
}

function isNotFound(cause: unknown): boolean {
  const code = (cause as { code?: unknown })?.code;
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchBucket';
}

/** Error text safe to log: never the credentials the client was built with. */
function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function toBuffer(content: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    return content;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of content as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
