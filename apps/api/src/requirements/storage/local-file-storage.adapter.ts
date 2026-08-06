import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import { REQUIREMENT_ROUTES } from '@wdrg/contracts';

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
 * The local-filesystem implementation of `FileStoragePort`.
 *
 * **Nothing here is web-served.** The storage root sits outside the applications'
 * static directories and is never mounted by Express, so there is no URL that
 * reaches a file except the API route that checks the session first. That is the
 * whole design: authorization is not a property of the path, it is a property of
 * the only code that can produce the bytes.
 *
 * Paths are built from two application-generated values — the project id and a
 * minted object id — and never from anything a client supplied. A traversal
 * attempt has nowhere to go because the filename never participates in the path
 * at all. `assertWithinRoot` is a belt-and-braces check that the arithmetic
 * above it is right, not the thing standing between an attacker and the disk.
 *
 * S3 is deliberately not implemented in this phase. The port exists, the
 * application depends only on the port, and a second adapter is a self-contained
 * addition — but writing an untested storage backend would be worse than not
 * writing one, and there is no deployment yet to test it against. See ADR-0011.
 */
@Injectable()
export class LocalFileStorageAdapter implements FileStoragePort {
  private readonly logger = new Logger(LocalFileStorageAdapter.name);
  private readonly root: string;

  constructor(private readonly config: AppConfigService) {
    const configured = this.config.upload.storageRoot;
    this.root = isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured);
  }

  /** Mints an opaque object id. Never derived from anything client-supplied. */
  static newObjectId(): string {
    return randomBytes(16).toString('hex');
  }

  async put(request: PutObjectRequest): Promise<StoredObjectMetadata> {
    const content = await toBuffer(request.content);
    const path = this.pathFor(request.key);

    try {
      await mkdir(this.projectDirectory(request.key.projectId), { recursive: true });
      // `wx` fails rather than overwrites. Two objects sharing an id would mean
      // the id generator is broken, and silently clobbering the first would turn
      // that into lost data instead of a loud error.
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      this.logger.error({ cause, projectId: request.key.projectId }, 'Failed to store object');
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
    const path = this.pathFor(key);
    await this.assertExists(path, key);

    return createReadStream(path);
  }

  async head(key: StoredObjectKey): Promise<StoredObjectMetadata> {
    const path = this.pathFor(key);
    const stats = await this.assertExists(path, key);

    return {
      key,
      sizeBytes: stats.size,
      // The filesystem does not record a content type; the source document in
      // MongoDB is the authority for that, and inventing one here would give
      // callers a second, less reliable answer to the same question.
      contentType: 'application/octet-stream',
      checksumSha256: '',
      createdAt: stats.birthtime,
    };
  }

  async exists(key: StoredObjectKey): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns an API URL, not a signed one.
   *
   * A filesystem has nothing to sign with, and inventing a token here would
   * create a second authorization mechanism that has to be kept in step with the
   * session guard. Routing back through the API means the download path is
   * checked by exactly the same code as every other project operation — which is
   * also what an S3 adapter should do for anything genuinely sensitive.
   */
  createSignedDownload(key: StoredObjectKey, ttlSeconds: number): Promise<SignedDownload> {
    return Promise.resolve({
      url: `${this.config.server.publicUrl}${REQUIREMENT_ROUTES.download(key.objectId)}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
    });
  }

  async delete(key: StoredObjectKey): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deleteProject(projectId: string): Promise<void> {
    await rm(this.projectDirectory(projectId), { recursive: true, force: true });
  }

  private async assertExists(path: string, key: StoredObjectKey) {
    try {
      return await stat(path);
    } catch (cause) {
      throw new FileStorageError('not_found', `No stored object ${key.objectId}.`, { cause });
    }
  }

  private projectDirectory(projectId: string): string {
    assertOpaque(projectId, 'projectId');
    return join(this.root, projectId);
  }

  private pathFor(key: StoredObjectKey): string {
    assertOpaque(key.objectId, 'objectId');

    const path = join(this.projectDirectory(key.projectId), key.objectId);
    assertWithinRoot(this.root, path);

    return path;
  }
}

/**
 * Both path components must be opaque application identifiers.
 *
 * If either ever contains anything else, the bug is upstream — something has
 * started passing user input where an id belongs — and it should fail loudly
 * here rather than quietly build a path.
 */
function assertOpaque(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new FileStorageError('not_found', `Refusing to build a path from an unsafe ${label}.`);
  }
}

function assertWithinRoot(root: string, path: string): void {
  const resolved = resolve(path);

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new FileStorageError('not_found', 'Refusing to touch a path outside the storage root.');
  }
}

async function toBuffer(content: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    return content;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  return Buffer.concat(chunks);
}
