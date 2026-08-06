import { randomBytes } from 'node:crypto';

import type { AppConfigService } from '../src/config/app-config.service';
import { ClamAvScannerAdapter } from '../src/requirements/malware/clamav-scanner.adapter';
import { NullScannerAdapter } from '../src/requirements/malware/null-scanner.adapter';

/**
 * The scanner against a **real, self-hosted** ClamAV daemon.
 *
 * Nothing is mocked. A mocked antivirus proves that the adapter parses a string
 * it was handed; it proves nothing about whether a real daemon actually detects
 * anything, or whether an unreachable one is reported as a failure rather than
 * as "clean". The second is the failure mode that matters — a scanner that
 * silently starts passing everything is worse than no scanner, because it is
 * believed.
 *
 * Skipped, loudly, where no daemon is reachable.
 */

const HOST = process.env.CLAMAV_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CLAMAV_PORT ?? '3410');

function makeConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  return {
    isProduction: false,
    malware: {
      scanner: 'clamav',
      host: HOST,
      port: PORT,
      timeoutMs: 30_000,
      failClosed: true,
      ...(overrides.malware as object),
    },
  } as unknown as AppConfigService;
}

/**
 * EICAR: the industry-standard harmless test string.
 *
 * Every antivirus detects it by agreement, and it is not malware — it is 68
 * printable ASCII characters that do nothing. Using it means this suite can
 * prove detection works without anyone having to handle a real sample.
 *
 * Assembled at runtime from fragments so the repository itself does not contain
 * a file that a developer's own antivirus will quarantine mid-checkout.
 */
function eicar(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'];
  return Buffer.from(parts.join(''), 'ascii');
}

describe('ClamAvScannerAdapter against a self-hosted daemon', () => {
  const adapter = new ClamAvScannerAdapter(makeConfig());
  let available = false;

  beforeAll(async () => {
    const health = await adapter.health();
    available = health.available;

    if (!available) {
      console.warn(
        `SKIPPING ClamAV tests: no daemon at ${HOST}:${PORT}. Run "pnpm docker:up" and wait for it to load signatures.`,
      );
    }
  }, 60_000);

  it('reports the engine and its signature version', async () => {
    if (!available) return;

    const health = await adapter.health();

    expect(health.available).toBe(true);
    expect(health.engine.toLowerCase()).toContain('clamav');
    // A daemon running with year-old signatures is running and useless, so the
    // version has to be visible to whoever is looking at readiness.
    expect(health.signatureVersion).toBeDefined();
  }, 30_000);

  it('passes a clean file', async () => {
    if (!available) return;

    const result = await adapter.scan({
      content: Buffer.from('These are ordinary project requirements.\n'),
      correlationId: 'test-clean',
    });

    expect(result.verdict).toBe('CLEAN');
    expect(result.signature).toBeUndefined();
    expect(result.engine).toBe('clamav');
  }, 30_000);

  it('passes a clean binary of realistic size', async () => {
    if (!available) return;

    const result = await adapter.scan({
      content: randomBytes(2 * 1024 * 1024),
      correlationId: 'test-clean-large',
    });

    expect(result.verdict).toBe('CLEAN');
  }, 60_000);

  it('detects the EICAR test file and names the signature', async () => {
    if (!available) return;

    const result = await adapter.scan({ content: eicar(), correlationId: 'test-eicar' });

    expect(result.verdict).toBe('INFECTED');
    expect(result.signature).toBeTruthy();
    expect(result.signature?.toLowerCase()).toContain('eicar');
  }, 30_000);

  it('gives the same answer every time for the same content', async () => {
    if (!available) return;

    const first = await adapter.scan({ content: eicar(), correlationId: 'test-repeat-1' });
    const second = await adapter.scan({ content: eicar(), correlationId: 'test-repeat-2' });

    expect(first.verdict).toBe('INFECTED');
    expect(second.verdict).toBe('INFECTED');
    expect(second.signature).toBe(first.signature);
  }, 60_000);

  it('reports ERROR — never CLEAN — when the daemon is unreachable', async () => {
    // No daemon needed for this one: that is the point.
    const unreachable = new ClamAvScannerAdapter(makeConfig({ malware: { port: 1 } }));

    const result = await unreachable.scan({
      content: Buffer.from('anything'),
      correlationId: 'test-unreachable',
    });

    expect(result.verdict).toBe('ERROR');
    // The distinction this whole design turns on.
    expect(result.verdict).not.toBe('CLEAN');
  }, 30_000);

  it('reports the scanner as unavailable in health when it is down', async () => {
    const unreachable = new ClamAvScannerAdapter(makeConfig({ malware: { port: 1 } }));
    const health = await unreachable.health();

    expect(health.available).toBe(false);
    expect(health.detail).toBeTruthy();
  }, 30_000);

  it('reports TIMEOUT when the daemon does not answer in time', async () => {
    if (!available) return;

    // One millisecond: not enough for any real scan, so the timeout path is what
    // runs. Distinguished from ERROR because a timeout is retryable and a
    // protocol failure usually is not.
    const impatient = new ClamAvScannerAdapter(makeConfig({ malware: { timeoutMs: 1 } }));

    const result = await impatient.scan({
      content: randomBytes(1024 * 1024),
      correlationId: 'test-timeout',
    });

    expect(['TIMEOUT', 'ERROR']).toContain(result.verdict);
    expect(result.verdict).not.toBe('CLEAN');
  }, 30_000);

  it('reports ERROR for a reply it does not understand', async () => {
    // A plain TCP listener that answers with nonsense: an unrecognised reply is
    // a scanner that did not answer the question, and must not read as clean.
    const { createServer } = await import('node:net');
    const server = createServer((socket) => {
      socket.on('data', () => {
        socket.write('WELCOME TO THE WRONG PROTOCOL\n');
        socket.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const confused = new ClamAvScannerAdapter(makeConfig({ malware: { port } }));

      const result = await confused.scan({
        content: Buffer.from('x'),
        correlationId: 'test-garbage',
      });

      expect(result.verdict).toBe('ERROR');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe('NullScannerAdapter', () => {
  it('never reports a file clean in "none" mode', async () => {
    const adapter = new NullScannerAdapter({
      malware: { scanner: 'none' },
    } as unknown as AppConfigService);

    const result = await adapter.scan();

    // The single most important assertion in this file. A development mode that
    // answered CLEAN would train every caller, and every reader of the audit
    // trail, to treat an unscanned file as a checked one.
    expect(result.verdict).toBe('NOT_SCANNED');
    expect(result.verdict).not.toBe('CLEAN');
  });

  it('reports ERROR in "reject" mode, so every upload is refused', async () => {
    const adapter = new NullScannerAdapter({
      malware: { scanner: 'reject' },
    } as unknown as AppConfigService);

    const result = await adapter.scan();
    expect(result.verdict).toBe('ERROR');
  });

  it('reports itself unavailable rather than showing a green tick', async () => {
    const adapter = new NullScannerAdapter({
      malware: { scanner: 'none' },
    } as unknown as AppConfigService);

    const health = await adapter.health();

    expect(health.available).toBe(false);
    expect(health.detail).toMatch(/no malware scanner/i);
  });
});
