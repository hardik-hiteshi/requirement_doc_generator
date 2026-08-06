import type { AppConfigService } from './app-config.service';

/**
 * Configuration that is merely inconvenient in development and unacceptable in
 * production.
 *
 * Every rule here exists because the safe default and the *convenient* default
 * are different values, and a deployment that forgets to change one should find
 * out at startup rather than on the day it matters. A misconfiguration that
 * boots successfully is the dangerous kind: nothing looks wrong until an
 * unscanned file has been accepted, or a storage write has silently failed.
 *
 * These are checked once, at bootstrap, and reported together — a deployment
 * fixing three problems should learn about all three in one pass.
 */
export interface PolicyViolation {
  readonly setting: string;
  readonly problem: string;
  readonly fix: string;
}

export function checkProductionPolicy(config: AppConfigService): PolicyViolation[] {
  if (!config.isProduction) {
    return [];
  }

  const violations: PolicyViolation[] = [];

  /* ------------------------------------------------------------- storage */

  if (config.upload.adapter === 's3') {
    const s3 = config.s3;

    // Each named separately: "S3 is misconfigured" sends someone hunting, and
    // there are five things it could be.
    const required: readonly [string, string][] = [
      ['S3_ENDPOINT', s3.endpoint],
      ['S3_BUCKET', s3.bucket],
      ['S3_ACCESS_KEY', s3.accessKey],
      ['S3_SECRET_KEY', s3.secretKey],
    ];

    for (const [setting, value] of required) {
      if (value.trim().length === 0) {
        violations.push({
          setting,
          problem: 'is empty, but STORAGE_ADAPTER is set to s3.',
          fix: 'Point it at the S3-compatible server you run yourself — MinIO, for example.',
        });
      }
    }

    if (!s3.useSsl && !isLoopback(s3.endpoint)) {
      violations.push({
        setting: 'S3_USE_SSL',
        problem: 'is false for a storage server that is not on this host.',
        fix: 'Enable TLS, or terminate it in front of the storage server.',
      });
    }
  } else if (!config.upload.storageRoot.startsWith('/')) {
    /*
     * Filesystem storage is a legitimate production choice for a single node
     * with a backed-up volume, so it is not refused. A *relative* storage root
     * is refused: it resolves against the working directory, which means the
     * same deployment started from a different directory writes somewhere else
     * and silently cannot find what it stored yesterday.
     */
    violations.push({
      setting: 'UPLOAD_STORAGE_ROOT',
      problem: `is a relative path ("${config.upload.storageRoot}"), which moves with the working directory.`,
      fix: 'Use an absolute path on a volume that is backed up, or set STORAGE_ADAPTER=s3.',
    });
  }

  /* ------------------------------------------------------------- malware */

  if (config.malware.scanner === 'none') {
    violations.push({
      setting: 'MALWARE_SCANNER',
      problem:
        'is "none" in production, which would accept client documents without scanning them.',
      fix: 'Set MALWARE_SCANNER=clamav and run a ClamAV daemon, or set it to "reject" to refuse all uploads.',
    });
  }

  if (config.malware.scanner === 'clamav' && config.malware.host.trim().length === 0) {
    violations.push({
      setting: 'CLAMAV_HOST',
      problem: 'is empty, but MALWARE_SCANNER is set to clamav.',
      fix: 'Point it at the ClamAV daemon you run yourself.',
    });
  }

  /* ------------------------------------------------------------ sessions */

  if (config.session.secret.startsWith('development-only')) {
    violations.push({
      setting: 'PROJECT_SESSION_SECRET',
      problem: 'is still the development placeholder, so every session cookie is forgeable.',
      fix: 'Generate a value of at least 32 random characters.',
    });
  }

  /* ------------------------------------------------------------------ AI */

  if (config.ai.provider !== 'disabled' && config.ai.baseUrl.trim().length === 0) {
    violations.push({
      setting: 'AI_BASE_URL',
      problem: 'is empty, but an AI provider is selected.',
      fix: 'Point it at the inference server you run yourself. This application never calls a hosted model vendor.',
    });
  }

  return violations;
}

/** A message an operator can act on, listing every problem at once. */
export function describeViolations(violations: readonly PolicyViolation[]): string {
  const lines = violations.map(
    (violation) => `  - ${violation.setting} ${violation.problem}\n      ${violation.fix}`,
  );

  return [
    'This deployment is not configured safely for production:',
    ...lines,
    '',
    'See docs/operations/self-hosting.md. Nothing here requires a paid service.',
  ].join('\n');
}

function isLoopback(endpoint: string): boolean {
  const host = endpoint.replace(/^https?:\/\//, '').split(':')[0] ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
