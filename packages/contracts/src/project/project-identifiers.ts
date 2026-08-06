/**
 * Public identifiers for anonymous projects.
 *
 * Two values, with deliberately different jobs:
 *
 * - The **public project id** names the project. It appears in URLs and API
 *   paths. It is unguessable so a project cannot be found by enumeration, but on
 *   its own it grants nothing.
 * - The **recovery secret** authorises access. It is never stored in readable
 *   form and is exchanged once for a session cookie.
 *
 * Separating them means the identifier can appear in logs, error envelopes and
 * the address bar without becoming a credential.
 */

/** Prefix on every public project id, so a value's kind is obvious in a log. */
export const PROJECT_ID_PREFIX = 'prj_' as const;

/**
 * 26 characters of Crockford base32 carry 128 bits of entropy — far beyond what
 * enumeration could search, while staying case-insensitive and free of the
 * characters people misread (I, L, O, U).
 */
export const PROJECT_ID_BODY_LENGTH = 26;

export const PROJECT_ID_PATTERN = /^prj_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** Alphabet used for public ids. Excludes I, L, O and U. */
export const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value);
}

/**
 * Recovery secrets are 32 random bytes rendered as base64url — 256 bits, well
 * beyond brute force, and safe to place in a URL fragment without escaping.
 */
export const RECOVERY_SECRET_BYTES = 32;
export const RECOVERY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isRecoverySecret(value: unknown): value is string {
  return typeof value === 'string' && RECOVERY_SECRET_PATTERN.test(value);
}

/**
 * Where the recovery secret lives in a recovery link.
 *
 * The secret goes in the URL **fragment**, never the query string. A fragment is
 * not sent to the server, so it cannot appear in access logs, proxy logs or a
 * `Referer` header — the three places a query parameter leaks to without anyone
 * noticing. The client reads it, exchanges it for a session, then clears it from
 * the address bar with `history.replaceState`.
 */
export const RECOVERY_FRAGMENT_PROJECT_KEY = 'p' as const;
export const RECOVERY_FRAGMENT_SECRET_KEY = 's' as const;

/** Path of the recovery page in the web application. */
export const RECOVERY_PATH = '/recover' as const;

/**
 * Builds the private recovery link a user must save.
 *
 * @param baseUrl absolute origin of the web application, no trailing slash
 */
export function buildRecoveryLink(
  baseUrl: string,
  projectId: string,
  recoverySecret: string,
): string {
  // Built by hand rather than with URLSearchParams: this package must stay
  // runtime-neutral, and pulling in the DOM or Node type libraries to get one
  // helper would open the door to browser-only APIs elsewhere in it. Both
  // values are already restricted to URL-safe alphabets, so no escaping is
  // needed — the patterns above guarantee it.
  const fragment =
    `${RECOVERY_FRAGMENT_PROJECT_KEY}=${projectId}` +
    `&${RECOVERY_FRAGMENT_SECRET_KEY}=${recoverySecret}`;

  return `${baseUrl.replace(/\/+$/, '')}${RECOVERY_PATH}#${fragment}`;
}

export interface ParsedRecoveryLink {
  readonly projectId: string;
  readonly recoverySecret: string;
}

/**
 * Reads a recovery fragment, returning `null` unless both values are
 * well-formed. Shape is checked before anything is sent to the server so a
 * mistyped link fails in the browser rather than as a failed auth attempt.
 */
export function parseRecoveryFragment(fragment: string): ParsedRecoveryLink | null {
  const entries = new Map<string, string>();

  for (const pair of fragment.replace(/^#/, '').split('&')) {
    const separator = pair.indexOf('=');

    if (separator > 0) {
      entries.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  const projectId = entries.get(RECOVERY_FRAGMENT_PROJECT_KEY);
  const recoverySecret = entries.get(RECOVERY_FRAGMENT_SECRET_KEY);

  if (!isProjectId(projectId) || !isRecoverySecret(recoverySecret)) {
    return null;
  }

  return { projectId, recoverySecret };
}
