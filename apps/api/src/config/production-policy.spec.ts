import type { AppConfigService } from './app-config.service';
import { checkProductionPolicy, describeViolations } from './production-policy';

/**
 * The rules that make a production deployment refuse to start.
 *
 * Each of these exists because the *convenient* default and the *safe* default
 * are different values. A misconfiguration that boots successfully is the
 * dangerous kind: nothing looks wrong until an unscanned file has been accepted.
 */

function config(overrides: Record<string, unknown> = {}): AppConfigService {
  return {
    isProduction: true,
    upload: { adapter: 's3' },
    s3: {
      endpoint: 'storage.internal',
      port: 9000,
      useSsl: true,
      bucket: 'requirements',
      accessKey: 'key',
      secretKey: 'secret',
      region: 'us-east-1',
      signedUrlTtlSeconds: 300,
    },
    malware: { scanner: 'clamav', host: 'clamav.internal', port: 3310, failClosed: true },
    session: { secret: 'a-real-secret-of-sufficient-length-0000000' },
    ai: { provider: 'disabled', baseUrl: '', model: '' },
    ...overrides,
  } as unknown as AppConfigService;
}

describe('production policy', () => {
  it('accepts a properly configured deployment', () => {
    expect(checkProductionPolicy(config())).toEqual([]);
  });

  it('checks nothing outside production', () => {
    // Development runs on a filesystem with no scanner, deliberately. Applying
    // these rules there would make the product unusable to work on.
    const development = config({
      isProduction: false,
      upload: { adapter: 'filesystem', storageRoot: './storage/uploads' },
      malware: { scanner: 'none' },
      session: { secret: 'development-only-session-secret-value-000000' },
    });

    expect(checkProductionPolicy(development)).toEqual([]);
  });

  it.each([
    ['S3_ENDPOINT', { endpoint: '' }],
    ['S3_BUCKET', { bucket: '' }],
    ['S3_ACCESS_KEY', { accessKey: '' }],
    ['S3_SECRET_KEY', { secretKey: '' }],
  ])('refuses to start when %s is missing', (setting, s3Override) => {
    const violations = checkProductionPolicy(
      config({ s3: { ...(config().s3 as object), ...s3Override } }),
    );

    expect(violations.map((violation) => violation.setting)).toContain(setting);
  });

  it('refuses plaintext storage traffic to a remote host', () => {
    const violations = checkProductionPolicy(
      config({ s3: { ...(config().s3 as object), useSsl: false } }),
    );

    expect(violations.map((violation) => violation.setting)).toContain('S3_USE_SSL');
  });

  it('allows plaintext to a storage server on the same host', () => {
    const violations = checkProductionPolicy(
      config({ s3: { ...(config().s3 as object), useSsl: false, endpoint: '127.0.0.1' } }),
    );

    expect(violations.map((violation) => violation.setting)).not.toContain('S3_USE_SSL');
  });

  it('accepts filesystem storage on an absolute path', () => {
    // A single node with a backed-up volume is a legitimate choice, so this is
    // not refused.
    const violations = checkProductionPolicy(
      config({ upload: { adapter: 'filesystem', storageRoot: '/var/lib/wdrg/uploads' } }),
    );

    expect(violations).toEqual([]);
  });

  it('refuses a relative storage root, which moves with the working directory', () => {
    const violations = checkProductionPolicy(
      config({ upload: { adapter: 'filesystem', storageRoot: './storage/uploads' } }),
    );

    expect(violations.map((violation) => violation.setting)).toContain('UPLOAD_STORAGE_ROOT');
  });

  it('refuses to start with no malware scanner', () => {
    const violations = checkProductionPolicy(config({ malware: { scanner: 'none' } }));

    const scanner = violations.find((violation) => violation.setting === 'MALWARE_SCANNER');
    expect(scanner).toBeDefined();
    expect(scanner?.problem).toMatch(/without scanning/i);
  });

  it('accepts "reject", which refuses uploads rather than passing them unscanned', () => {
    const violations = checkProductionPolicy(
      config({ malware: { scanner: 'reject', host: '', port: 3310, failClosed: true } }),
    );

    expect(violations.map((violation) => violation.setting)).not.toContain('MALWARE_SCANNER');
  });

  it('refuses the development session secret', () => {
    const violations = checkProductionPolicy(
      config({ session: { secret: 'development-only-session-secret-value-000000' } }),
    );

    expect(violations.map((violation) => violation.setting)).toContain('PROJECT_SESSION_SECRET');
  });

  it('refuses an AI provider with no self-hosted endpoint', () => {
    const violations = checkProductionPolicy(
      config({ ai: { provider: 'ollama', baseUrl: '', model: 'llama3.1:8b' } }),
    );

    const ai = violations.find((violation) => violation.setting === 'AI_BASE_URL');
    expect(ai).toBeDefined();
    expect(ai?.fix).toMatch(/run yourself/i);
  });

  it('reports every problem at once, with a fix for each', () => {
    const violations = checkProductionPolicy(
      config({
        upload: { adapter: 'filesystem', storageRoot: './relative' },
        malware: { scanner: 'none' },
        session: { secret: 'development-only-session-secret-value-000000' },
      }),
    );

    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.every((violation) => violation.fix.length > 0)).toBe(true);

    const message = describeViolations(violations);

    expect(message).toContain('UPLOAD_STORAGE_ROOT');
    expect(message).toContain('MALWARE_SCANNER');
    expect(message).toContain('PROJECT_SESSION_SECRET');
    // The whole point of the constraint: fixing this never costs a subscription.
    expect(message).toContain('Nothing here requires a paid service');
  });

  it('never names a secret value in its output', () => {
    const violations = checkProductionPolicy(
      config({
        s3: { ...(config().s3 as object), secretKey: '' },
        session: { secret: 'development-only-session-secret-value-000000' },
      }),
    );

    const message = describeViolations(violations);

    expect(message).toContain('S3_SECRET_KEY');
    // The name of the setting, never what is in it.
    expect(message).not.toContain('development-only-session-secret-value');
  });
});
