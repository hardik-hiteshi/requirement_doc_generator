import {
  ADMIN_TOKEN_MIN_LENGTH,
  checkInferenceEndpoint,
  isProductionUsable,
} from '@wdrg/contracts';

import { findModelProfile } from '../analysis/models/model-profiles';
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

  if (config.ai.provider !== 'disabled') {
    /*
     * The deterministic provider returns fixtures. Reaching production with it
     * selected would produce a requirement baseline made of nothing, presented
     * with exactly the same confidence as a real one — which is the worst
     * possible failure for a document a client signs.
     */
    if (config.ai.provider === 'deterministic') {
      violations.push({
        setting: 'AI_PROVIDER',
        problem: 'is "deterministic", which returns test fixtures rather than analysing anything.',
        fix: 'Set AI_PROVIDER=ollama or local-openai-compatible, pointing at an inference server you run.',
      });
    }

    /*
     * Belt and braces. The scenario only does anything with the deterministic
     * provider, which is already refused above — but a setting that turns a
     * stub into a source of requirements has no business being set in
     * production under any provider, and saying so is cheaper than reasoning
     * about whether it could ever matter.
     */
    if (config.ai.deterministicScenario !== '') {
      violations.push({
        setting: 'AI_DETERMINISTIC_SCENARIO',
        problem: 'is set, which only has meaning for the test provider.',
        fix: 'Leave it empty. It exists so the browser suite can run without a model.',
      });
    }

    // The endpoint policy, at startup as well as per request: a deployment that
    // has pointed at a vendor should find out before it accepts any work.
    const endpoint = checkInferenceEndpoint(config.ai.baseUrl, {
      requirePrivateAddress: true,
      rejectLoopback: config.ai.requireRemoteEndpoint,
    });

    if (!endpoint.allowed && config.ai.provider !== 'deterministic') {
      violations.push({
        setting: 'AI_BASE_URL',
        problem: endpoint.reason ?? 'is not a permitted inference endpoint.',
        fix: 'Point it at an inference server on your own network. Requirement content never leaves your infrastructure.',
      });
    }

    const profileId = config.ai.modelProfile.trim();

    if (profileId.length === 0) {
      violations.push({
        setting: 'AI_MODEL_PROFILE',
        problem: 'is empty, but an AI provider is selected.',
        fix: 'Name one of the model profiles. Each records its licence and its limits.',
      });
    } else {
      const profile = findModelProfile(profileId);

      if (!profile) {
        violations.push({
          setting: 'AI_MODEL_PROFILE',
          problem: `names "${profileId}", which is not a known model profile.`,
          fix: 'Use a profile from apps/api/src/analysis/models/model-profiles.ts, or add one.',
        });
      } else {
        const usable = isProductionUsable(profile);

        if (!usable.usable) {
          violations.push({
            setting: 'AI_MODEL_PROFILE',
            problem: usable.reason ?? 'is not approved for production.',
            fix: 'Validate the model, record its licence, and set validationStatus to production-approved.',
          });
        }

        if (!profile.structuredOutput) {
          violations.push({
            setting: 'AI_MODEL_PROFILE',
            problem: `"${profile.id}" does not reliably produce structured output, which every analysis task requires.`,
            fix: 'Choose a model that supports constrained JSON output.',
          });
        }
      }
    }
  }

  /* -------------------------------------------------- abuse and retention */

  /*
   * A production deployment with no request ceilings has no defence against a
   * script, a stuck client or a deliberate flood — and the expensive paths here run
   * a model or render a document, so the cost of an unbounded caller is real.
   */
  if (!config.rateLimit.enabled) {
    violations.push({
      setting: 'RATE_LIMIT_ENABLED',
      problem: 'is false, so nothing limits how fast one caller can run models or render exports.',
      fix: 'Leave it at its default of true. Adjust the individual RATE_LIMIT_* ceilings instead.',
    });
  }

  /*
   * Purging the moment a deletion is requested removes the window in which a
   * mistake can be undone, and with it the point of the pending state.
   */
  if (config.retention.enabled && config.retention.policy.deletionGraceDays === 0) {
    violations.push({
      setting: 'RETENTION_DELETION_GRACE_DAYS',
      problem: 'is 0, so a deletion is irreversible the moment it is requested.',
      fix: 'Allow at least a day, so an accidental deletion can be caught.',
    });
  }

  /* ------------------------------------------------------ operator surface */

  if (config.admin.enabled && config.admin.token.length < ADMIN_TOKEN_MIN_LENGTH) {
    violations.push({
      setting: 'ADMIN_API_TOKEN',
      problem: `is shorter than ${ADMIN_TOKEN_MIN_LENGTH} characters, which is guessable for a credential that reads the audit trail.`,
      fix: `Generate at least ${ADMIN_TOKEN_MIN_LENGTH} random characters, or leave it empty to disable the operator surface.`,
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

/**
 * Configuration worth saying out loud that must not stop a deployment.
 *
 * The difference from a violation is whether the setting is *wrong* or merely
 * *consequential*. A forgeable session secret is wrong: no deployment wants it, and
 * booting anyway would hand out cookies anybody can mint. Keeping every project for
 * ever is a decision — some deployments are contractually required to — and refusing
 * to start over somebody's lawful data policy would be the tool overruling its
 * operator.
 *
 * So these are logged loudly at startup and the process continues. The distinction
 * matters in practice: without it, the only way to run with retention off is to have
 * the API refuse to boot, which is how a check that was meant to inform becomes a
 * check people work around.
 */
export function productionAdvisories(config: AppConfigService): PolicyViolation[] {
  if (!config.isProduction) {
    return [];
  }

  const advisories: PolicyViolation[] = [];

  if (!config.retention.enabled) {
    advisories.push({
      setting: 'RETENTION_ENABLED',
      problem:
        'is false, so expired and deleted projects keep their content — including uploaded client files — indefinitely.',
      fix: 'Set RETENTION_ENABLED=true with windows your data policy allows, or record the decision to keep everything.',
    });
  }

  return advisories;
}

/** The advisory list, phrased so nobody mistakes it for a refusal. */
export function describeAdvisories(advisories: readonly PolicyViolation[]): string {
  const lines = advisories.map(
    (advisory) => `  - ${advisory.setting} ${advisory.problem}\n      ${advisory.fix}`,
  );

  return [
    'This deployment has started, with operational choices worth reviewing:',
    ...lines,
    '',
    'See docs/operations/retention.md.',
  ].join('\n');
}
