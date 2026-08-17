import { MODEL_PROFILES } from '../analysis/models/model-profiles';
import type { AppConfigService } from './app-config.service';
import {
  checkProductionPolicy,
  describeAdvisories,
  describeViolations,
  productionAdvisories,
} from './production-policy';

/**
 * The rules that make a production deployment refuse to start.
 *
 * Each of these exists because the *convenient* default and the *safe* default
 * are different values. A misconfiguration that boots successfully is the
 * dangerous kind: nothing looks wrong until an unscanned file has been accepted.
 */

function config(
  overrides: Record<string, unknown> & { ai?: Record<string, unknown> } = {},
): AppConfigService {
  const { ai, ...rest } = overrides;

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
    /* A deployment that has made the operational choices Phase 12 introduced. */
    rateLimit: { enabled: true, maxKeys: 50_000 },
    retention: {
      enabled: true,
      sweepIntervalMs: 3_600_000,
      policy: { deletionGraceDays: 7, expiredGraceDays: 90, batchSize: 25 },
    },
    admin: { enabled: false, token: '' },
    ...rest,
    ai: {
      provider: 'disabled',
      baseUrl: '',
      model: '',
      modelProfile: '',
      modelOverride: '',
      requestTimeoutMs: 120_000,
      runTimeoutMs: 900_000,
      maxContextTokens: 0,
      maxOutputTokens: 0,
      maxAttempts: 3,
      requireRemoteEndpoint: false,
      deterministicScenario: '',
      ...(ai ?? {}),
    },
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

  /* ------------------------------------------------------------------ AI */

  const settings = (overrides: Record<string, unknown>): string[] =>
    checkProductionPolicy(config({ ai: overrides })).map((violation) => violation.setting);

  it('checks nothing about AI when no provider is selected', () => {
    // Every other phase of the product works without it, and a deployment that
    // has not enabled analysis should not be asked to name a model.
    expect(checkProductionPolicy(config({ ai: { provider: 'disabled' } }))).toEqual([]);
  });

  it('refuses the deterministic provider, which returns fixtures rather than analysis', () => {
    const violations = checkProductionPolicy(
      config({ ai: { provider: 'deterministic', modelProfile: 'deterministic-test' } }),
    );

    const provider = violations.find((violation) => violation.setting === 'AI_PROVIDER');

    expect(provider).toBeDefined();
    expect(provider?.problem).toMatch(/fixtures/i);
  });

  it('refuses an AI provider with no endpoint at all', () => {
    const violations = checkProductionPolicy(
      config({ ai: { provider: 'ollama', baseUrl: '', modelProfile: 'qwen2.5-7b-instruct' } }),
    );

    const endpoint = violations.find((violation) => violation.setting === 'AI_BASE_URL');

    expect(endpoint).toBeDefined();
    expect(endpoint?.fix).toMatch(/your own network/i);
  });

  it.each([
    ['https://api.openai.com/v1', 'a hosted vendor'],
    ['https://api.anthropic.com', 'a hosted vendor'],
    ['https://generativelanguage.googleapis.com', 'a hosted vendor'],
    ['http://203.0.113.10:11434', 'a public address'],
  ])('refuses %s, which is %s', (baseUrl) => {
    expect(
      settings({ provider: 'ollama', baseUrl, modelProfile: 'qwen2.5-7b-instruct' }),
    ).toContain('AI_BASE_URL');
  });

  it("accepts an inference server on the operator's own network", () => {
    // The endpoint is fine; only the unapproved profile is objected to, which is
    // what proves the address itself passed.
    expect(
      settings({
        provider: 'ollama',
        baseUrl: 'http://ollama.internal:11434',
        modelProfile: 'qwen2.5-7b-instruct',
      }),
    ).not.toContain('AI_BASE_URL');
  });

  it.each([
    ['', /is empty/i],
    ['gpt-4o', /not a known model profile/i],
  ])('refuses AI_MODEL_PROFILE %p', (modelProfile, expected) => {
    const violations = checkProductionPolicy(
      config({
        ai: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', modelProfile },
      }),
    );

    const profile = violations.find((violation) => violation.setting === 'AI_MODEL_PROFILE');

    expect(profile).toBeDefined();
    expect(profile?.problem).toMatch(expected);
  });

  it('refuses every profile shipped with the application until an operator approves one', () => {
    /*
     * Not an oversight — the deliberate consequence of the model-profile design.
     * Nothing shipped here is production-approved, because approval means
     * someone checked this model's licence and this model's behaviour on their
     * own hardware. Shipping a pre-approved profile would make that decision on
     * their behalf, silently.
     *
     * This test fails the moment a profile is marked production-approved in the
     * repository, which is exactly when someone should have to think about it.
     */
    for (const profile of MODEL_PROFILES) {
      expect(
        settings({
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          modelProfile: profile.id,
        }),
      ).toContain('AI_MODEL_PROFILE');
    }
  });

  it('refuses the test provider’s echo scenario in production', () => {
    // Only meaningful for the deterministic provider, which is already refused
    // — but a setting that turns a stub into a source of requirements has no
    // business being set in production under any provider.
    expect(settings({ provider: 'ollama', deterministicScenario: 'echo' })).toContain(
      'AI_DETERMINISTIC_SCENARIO',
    );
  });

  it('never prints the endpoint it rejected', () => {
    const violations = checkProductionPolicy(
      config({
        ai: {
          provider: 'local-openai-compatible',
          baseUrl: 'https://user:hunter2pass@api.openai.com',
          modelProfile: 'qwen2.5-7b-instruct',
        },
      }),
    );

    const message = describeViolations(violations);

    expect(message).toContain('AI_BASE_URL');
    expect(message).not.toContain('hunter2pass');
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

describe('production advisories', () => {
  it('says nothing when retention is enabled', () => {
    expect(productionAdvisories(config())).toEqual([]);
  });

  it('warns, rather than refusing, when nothing is ever purged', () => {
    /*
     * The distinction the two lists exist for. A forgeable secret is wrong and stops
     * the process; keeping every project for ever is a decision some deployments are
     * required to make, and refusing to start over a lawful data policy would be the
     * tool overruling its operator.
     */
    const advisories = productionAdvisories(
      config({
        retention: {
          enabled: false,
          sweepIntervalMs: 3_600_000,
          policy: { deletionGraceDays: 7, expiredGraceDays: 90, batchSize: 25 },
        },
      }),
    );

    expect(advisories.map((advisory) => advisory.setting)).toEqual(['RETENTION_ENABLED']);

    /* And it is not among the reasons a deployment refuses to boot. */
    expect(
      checkProductionPolicy(
        config({
          retention: {
            enabled: false,
            sweepIntervalMs: 3_600_000,
            policy: { deletionGraceDays: 7, expiredGraceDays: 90, batchSize: 25 },
          },
        }),
      ).map((violation) => violation.setting),
    ).not.toContain('RETENTION_ENABLED');
  });

  it('says nothing at all outside production', () => {
    expect(
      productionAdvisories(
        config({
          isProduction: false,
          retention: {
            enabled: false,
            sweepIntervalMs: 3_600_000,
            policy: { deletionGraceDays: 7, expiredGraceDays: 90, batchSize: 25 },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('reads as a warning rather than a refusal', () => {
    const text = describeAdvisories(
      productionAdvisories(
        config({
          retention: {
            enabled: false,
            sweepIntervalMs: 3_600_000,
            policy: { deletionGraceDays: 7, expiredGraceDays: 90, batchSize: 25 },
          },
        }),
      ),
    );

    expect(text).toContain('has started');
    expect(text).not.toContain('not configured safely');
  });
});
