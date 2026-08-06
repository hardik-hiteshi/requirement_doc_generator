import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import type { AppConfigService } from '../src/config/app-config.service';
import { FileStorageError } from '../src/ports';
import {
  S3FileStorageAdapter,
  objectKey,
} from '../src/requirements/storage/s3-file-storage.adapter';

/**
 * The S3 adapter against a **real, self-hosted** MinIO container.
 *
 * Nothing here is mocked. A mocked object store proves that the adapter calls
 * the functions it calls; it proves nothing about whether a bucket policy is
 * private, whether a missing object raises the error the application expects, or
 * whether a prefix delete actually removes anything. Storage is where data loss
 * lives, and a mock cannot find any of it.
 *
 * No cloud account is involved. MinIO runs in the compose stack, and S3 here is
 * a wire protocol rather than a vendor.
 *
 * Skipped, loudly, where no MinIO is reachable — a test that silently passes
 * without the service it is testing reports coverage that does not exist.
 */

const S3_HOST = process.env.S3_ENDPOINT ?? '127.0.0.1';
const S3_PORT = Number(process.env.S3_PORT ?? '9100');
const BUCKET = process.env.S3_BUCKET ?? 'wdrg-requirements';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): AppConfigService {
  return {
    isProduction: false,
    upload: { adapter: 's3' },
    s3: {
      endpoint: S3_HOST,
      port: S3_PORT,
      useSsl: false,
      bucket: BUCKET,
      accessKey: process.env.S3_ACCESS_KEY ?? 'wdrg-dev-access-key',
      secretKey: process.env.S3_SECRET_KEY ?? 'wdrg-dev-secret-key',
      region: 'us-east-1',
      signedUrlTtlSeconds: 300,
      ...(overrides.s3 as object),
    },
    server: { publicUrl: 'http://127.0.0.1:3001' },
    ...overrides,
  } as unknown as AppConfigService;
}

/** A project id in the same shape the application mints. */
const projectId = (): string => `prj_${randomBytes(13).toString('hex').toUpperCase()}`;
const objectId = (): string => randomBytes(16).toString('hex');

describe('S3FileStorageAdapter against self-hosted MinIO', () => {
  let adapter: S3FileStorageAdapter;
  let available = false;
  const created: { projectId: string; objectId: string }[] = [];

  beforeAll(async () => {
    adapter = new S3FileStorageAdapter(makeConfig());

    try {
      await adapter.onModuleInit();
      available = true;
    } catch {
      console.warn(
        `SKIPPING MinIO tests: no S3-compatible server at ${S3_HOST}:${S3_PORT}. Run "pnpm docker:up".`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (!available) {
      return;
    }

    // Every project this suite touched, removed by prefix.
    const projects = [...new Set(created.map((key) => key.projectId))];

    for (const project of projects) {
      await adapter.deleteProject(project).catch(() => undefined);
    }
  }, 30_000);

  const track = (key: { projectId: string; objectId: string }) => {
    created.push(key);
    return key;
  };

  it('stores an object and reports its size and checksum', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });
    const content = Buffer.from('a requirement document');

    const metadata = await adapter.put({
      key,
      content,
      contentType: 'text/plain',
      originalFilename: 'brief.txt',
    });

    expect(metadata.sizeBytes).toBe(content.length);
    expect(metadata.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('streams the object back byte for byte', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });
    // Larger than one chunk, so a truncation bug has somewhere to show.
    const content = randomBytes(512 * 1024);

    await adapter.put({ key, content, contentType: 'application/octet-stream' });

    const stream = await adapter.getStream(key);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks).equals(content)).toBe(true);
  }, 30_000);

  it('accepts a readable stream as input', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });

    await adapter.put({
      key,
      content: Readable.from([Buffer.from('streamed '), Buffer.from('content')]),
      contentType: 'text/plain',
    });

    const head = await adapter.head(key);
    expect(head.sizeBytes).toBe('streamed content'.length);
  });

  it('reports existence honestly in both directions', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });

    expect(await adapter.exists(key)).toBe(false);

    await adapter.put({ key, content: Buffer.from('x'), contentType: 'text/plain' });

    expect(await adapter.exists(key)).toBe(true);
  });

  it('returns metadata for a stored object', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });
    await adapter.put({ key, content: Buffer.from('metadata'), contentType: 'text/plain' });

    const head = await adapter.head(key);

    expect(head.sizeBytes).toBe(8);
    expect(head.contentType).toBe('text/plain');
    // Deliberately empty: the stored ETag is not a SHA-256, and reporting it as
    // one would be a lie a caller could act on.
    expect(head.checksumSha256).toBe('');
  });

  it('raises not_found for a missing object rather than something generic', async () => {
    if (!available) return;

    const missing = { projectId: projectId(), objectId: objectId() };

    await expect(adapter.getStream(missing)).rejects.toMatchObject({
      name: 'FileStorageError',
      reason: 'not_found',
    });
    await expect(adapter.head(missing)).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('refuses an object key built from anything but an identifier', () => {
    if (!available) return;

    // Traversal has nowhere to go, because a filename never reaches a key — but
    // if one ever did, this must fail loudly rather than build the key.
    for (const unsafe of ['../other-project', 'a/b', 'has space', '', 'x'.repeat(200)]) {
      expect(() => objectKey({ projectId: unsafe, objectId: objectId() })).toThrow(
        FileStorageError,
      );
      expect(() => objectKey({ projectId: projectId(), objectId: unsafe })).toThrow(
        FileStorageError,
      );
    }
  });

  it('keeps one project’s objects out of another’s prefix', async () => {
    if (!available) return;

    const first = track({ projectId: projectId(), objectId: objectId() });
    const second = track({ projectId: projectId(), objectId: objectId() });

    await adapter.put({ key: first, content: Buffer.from('first'), contentType: 'text/plain' });
    await adapter.put({ key: second, content: Buffer.from('second'), contentType: 'text/plain' });

    // Same object id, other project: must not resolve. This is the cross-tenant
    // check — the key prefix is what isolates projects.
    const crossed = { projectId: second.projectId, objectId: first.objectId };
    expect(await adapter.exists(crossed)).toBe(false);

    // And deleting one project leaves the other untouched.
    await adapter.deleteProject(first.projectId);

    expect(await adapter.exists(first)).toBe(false);
    expect(await adapter.exists(second)).toBe(true);
  }, 30_000);

  it('deletes an object, and treats a repeated delete as success', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });
    await adapter.put({ key, content: Buffer.from('temporary'), contentType: 'text/plain' });

    await adapter.delete(key);
    expect(await adapter.exists(key)).toBe(false);

    // Already gone is the outcome the caller wanted.
    await expect(adapter.delete(key)).resolves.toBeUndefined();
  });

  it('removes every object for a project in one pass', async () => {
    if (!available) return;

    const project = projectId();
    const keys = [1, 2, 3].map(() => track({ projectId: project, objectId: objectId() }));

    for (const key of keys) {
      await adapter.put({ key, content: Buffer.from('bulk'), contentType: 'text/plain' });
    }

    await adapter.deleteProject(project);

    for (const key of keys) {
      expect(await adapter.exists(key)).toBe(false);
    }
  }, 30_000);

  it('issues a presigned URL from the self-hosted server, bounded by the configured TTL', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });
    await adapter.put({ key, content: Buffer.from('signed'), contentType: 'text/plain' });

    // Asks for an hour; the configured ceiling is five minutes.
    const signed = await adapter.createSignedDownload(key, 3_600);

    expect(signed.url).toContain(`${S3_HOST}:${S3_PORT}`);
    expect(signed.url).toContain('X-Amz-Signature');
    expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(301 * 1_000);

    // And the URL actually works — a signed link that does not resolve is worse
    // than no signed link.
    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('signed');
  }, 30_000);

  it('refuses anonymous access to the bucket', async () => {
    if (!available) return;

    const key = track({ projectId: projectId(), objectId: objectId() });
    await adapter.put({ key, content: Buffer.from('private'), contentType: 'text/plain' });

    // The unsigned URL for the same object. A private bucket must refuse it —
    // this is what makes the storage key not a credential.
    const unsigned = `http://${S3_HOST}:${S3_PORT}/${BUCKET}/${objectKey(key)}`;
    const response = await fetch(unsigned);

    expect(response.status).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it('reports a storage failure as unavailable, not as a missing object', async () => {
    if (!available) return;

    // A port nothing is listening on: the difference between "gone" and "cannot
    // tell" is the whole reason the error carries a reason.
    const broken = new S3FileStorageAdapter(makeConfig({ s3: { port: 1 } }));

    await expect(
      broken.put({
        key: { projectId: projectId(), objectId: objectId() },
        content: Buffer.from('x'),
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ name: 'FileStorageError', reason: 'unavailable' });
  }, 30_000);

  it('fails startup when the bucket does not exist', async () => {
    if (!available) return;

    const wrongBucket = new S3FileStorageAdapter(
      makeConfig({ s3: { bucket: 'no-such-bucket-here' } }),
    );

    await expect(wrongBucket.onModuleInit()).rejects.toThrow(FileStorageError);
  }, 30_000);

  it('refuses to build a client when the endpoint is unconfigured', async () => {
    const unconfigured = new S3FileStorageAdapter(makeConfig({ s3: { endpoint: '', bucket: '' } }));

    // No default endpoint anywhere: an unconfigured deployment must not silently
    // reach for a public cloud.
    await expect(
      unconfigured.exists({ projectId: projectId(), objectId: objectId() }),
    ).rejects.toThrow(FileStorageError);
  });
});
