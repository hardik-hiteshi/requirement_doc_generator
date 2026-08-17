import { z } from 'zod';

/**
 * How much of the API one caller may use, per class of operation.
 *
 * Rate limiting exists here for a narrow reason: some requests cost far more than
 * others. A document generation runs a model, an export renders a file, an upload
 * scans and extracts — each is orders of magnitude more expensive than reading a
 * project. One ceiling across all of them would have to be set high enough for
 * ordinary browsing, which would leave the expensive paths effectively unlimited.
 * So requests are classified, and each class carries its own budget.
 *
 * ## Why fixed windows
 *
 * A fixed window is the simplest correct thing: a counter and an expiry. It admits
 * a burst at a window boundary — up to twice the budget across two adjacent windows
 * — which matters for a limiter defending a shared quota, and does not matter for
 * one defending a single machine's capacity. A sliding log would cost memory
 * proportional to traffic to remove a boundary effect nobody here can exploit
 * usefully.
 *
 * ## Not a quota, not a paywall
 *
 * These are protective ceilings, set well above what the interface generates in
 * normal use. A person working through the workflow should never see one. Anything
 * that does hit a ceiling is a script, a stuck retry loop, or abuse.
 */

export const RATE_LIMIT_CLASSES = [
  /** Everything not otherwise classified: reads, small writes, polling. */
  'default',
  /** State-changing requests, which are cheap but should not be hammered. */
  'mutation',
  /** Model runs, document generation, validation, estimation. */
  'expensive',
  /** File rendering and download. */
  'export',
  /** File ingestion: scanned, extracted, stored. */
  'upload',
  /** Recovering a project, where the abuse is guessing a recovery secret. */
  'access',
  /** Creating a project, where the abuse is filling the database. */
  'create',
] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export interface RateLimitPolicy {
  /** Requests permitted per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/**
 * Defaults, chosen against what the interface actually does.
 *
 * The document workspace polls a run's progress every couple of seconds and reads
 * several panels per navigation, so `default` has to accommodate a person clicking
 * around briskly on a slow connection. The expensive classes are set to a few times
 * what any real sequence of work needs: seven documents generated back to back is
 * well inside ten in five minutes, and nobody legitimately exports thirty files in
 * five minutes — but a runaway retry does.
 *
 * `access` is deliberately the tightest. It is the only class where the thing being
 * protected is a secret rather than a machine: ten recovery attempts per quarter
 * hour makes guessing a recovery phrase hopeless while leaving somebody who is
 * mistyping their own perfectly able to get in.
 *
 * `create` is separate from it, and far more generous, because the two are different
 * risks that happen to share a controller. Guessing a recovery secret is an attack on
 * one project's confidentiality; creating projects in bulk is an attack on disk. Both
 * are keyed by address for want of a session, but an agency starting a dozen projects
 * in an afternoon from one office is ordinary work, and putting it on the
 * credential-guessing budget would have locked them out after ten.
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimitClass, RateLimitPolicy>> = {
  default: { limit: 600, windowSeconds: 60 },
  mutation: { limit: 120, windowSeconds: 60 },
  expensive: { limit: 10, windowSeconds: 300 },
  export: { limit: 30, windowSeconds: 300 },
  upload: { limit: 30, windowSeconds: 3_600 },
  access: { limit: 10, windowSeconds: 900 },
  create: { limit: 30, windowSeconds: 3_600 },
};

export const rateLimitPolicySchema = z
  .object({
    limit: z.number().int().positive().max(1_000_000),
    windowSeconds: z.number().int().positive().max(86_400),
  })
  .strict();

export const rateLimitPoliciesSchema = z
  .object({
    default: rateLimitPolicySchema,
    mutation: rateLimitPolicySchema,
    expensive: rateLimitPolicySchema,
    export: rateLimitPolicySchema,
    upload: rateLimitPolicySchema,
    access: rateLimitPolicySchema,
    create: rateLimitPolicySchema,
  })
  .strict();

/** What a caller is told when a ceiling is reached. Deliberately uninformative. */
export const RATE_LIMITED_MESSAGE =
  'That was too many requests in a short time. Nothing has been changed — please wait a moment and try again.';

/**
 * Whether a class is keyed by network address rather than by session.
 *
 * Creating a project and recovering one both happen before there is a session, so
 * a session key would be either absent or attacker-chosen. Everything else is
 * keyed by the session, so one project cannot spend another's budget — and so a
 * shared office address is not one shared ceiling for ordinary work.
 */
export function isAddressKeyed(rateClass: RateLimitClass): boolean {
  return rateClass === 'access' || rateClass === 'create';
}

/**
 * The counter key for a request.
 *
 * The class is part of the key, so exhausting the export budget does not also
 * lock somebody out of reading their project.
 */
export function rateLimitKey(input: {
  readonly rateClass: RateLimitClass;
  readonly sessionId: string | undefined;
  readonly address: string;
}): string {
  const principal = isAddressKeyed(input.rateClass)
    ? `ip:${input.address}`
    : (input.sessionId ?? `ip:${input.address}`);

  return `${input.rateClass}|${principal}`;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests still available in this window. */
  readonly remaining: number;
  /** Seconds until the window resets. Sent as `Retry-After` on a refusal. */
  readonly retryAfterSeconds: number;
  readonly limit: number;
}
