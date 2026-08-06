import { z } from 'zod';

import { projectResponseSchema } from './project.contract';
import { PROJECT_ID_PATTERN, RECOVERY_SECRET_PATTERN } from './project-identifiers';

/**
 * Anonymous project access.
 *
 * ## Recovery semantics
 *
 * These four statements are the whole model, and every surface — API, UI, docs,
 * threat model — must agree with them:
 *
 * 1. **The recovery secret is shown once.** It is returned in the creation
 *    response and never again, because only a salted hash of it is stored. A
 *    user who loses the link loses the project; nobody can re-derive it.
 * 2. **The recovery link is reusable.** "Shown once" is about display, not about
 *    lifetime. The secret may be exchanged any number of times, from any device
 *    or browser, for as long as the project is usable.
 * 3. **Multiple project sessions may exist at the same time.** Sessions are
 *    stateless signed cookies with no server-side registry, so a new exchange
 *    issues an additional session rather than replacing an existing one.
 * 4. **Deletion or expiry ends everything.** Both make further exchange fail and
 *    make every outstanding session useless, because each request re-loads the
 *    project and checks its status.
 *
 * Regenerating or revoking a recovery credential is deliberately not offered —
 * see ADR-0010 for why an account-less product cannot do it safely.
 */

/**
 * The creation response — the only place the raw recovery secret ever appears.
 * The client is responsible for getting it in front of the user before they
 * navigate away.
 */
export const projectCreatedResponseSchema = z.object({
  project: projectResponseSchema,
  /** Raw recovery secret. Shown once here, and never retrievable again. */
  recoverySecret: z.string().regex(RECOVERY_SECRET_PATTERN),
  /** Ready-to-copy reusable link, with the secret in the URL fragment. */
  recoveryLink: z.string(),
  /** Plain-language statement of what holding the link means. */
  recoveryWarning: z.string(),
});

export type ProjectCreatedResponse = z.infer<typeof projectCreatedResponseSchema>;

/**
 * The single sentence every surface uses for this. Defined here so the warning
 * cannot drift between the creation panel, the recovery panel and the docs.
 */
export const RECOVERY_WARNING =
  'Anyone with this link can open, edit and delete this project. The link keeps working and can be used again from any device — but it is shown here only once and cannot be sent to you again, so save it somewhere safe before continuing.' as const;

/* --------------------------------------------------------------- exchange */

export const exchangeRecoverySecretRequestSchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  recoverySecret: z.string().regex(RECOVERY_SECRET_PATTERN),
});

export type ExchangeRecoverySecretRequest = z.infer<typeof exchangeRecoverySecretRequestSchema>;

/**
 * On success the session cookie is set by the response; the body carries the
 * project so the client needs no follow-up request.
 */
export const projectSessionResponseSchema = z.object({
  project: projectResponseSchema,
  session: z.object({
    projectId: z.string(),
    expiresAt: z.string(),
  }),
});

export type ProjectSessionResponse = z.infer<typeof projectSessionResponseSchema>;

/* ---------------------------------------------------------------- session */

export const endSessionResponseSchema = z.object({
  ended: z.literal(true),
});

export type EndSessionResponse = z.infer<typeof endSessionResponseSchema>;

/**
 * Names of the cookies the API sets.
 *
 * - The **session** cookie is `HttpOnly`: script must never be able to read it,
 *   because an XSS bug would otherwise hand over the project.
 * - The **CSRF** cookie is deliberately readable by script — that is the whole
 *   double-submit mechanism. It carries no authority on its own; it only proves
 *   the caller can read same-origin cookies, which a cross-site form cannot.
 */
export const PROJECT_SESSION_COOKIE = 'wdrg_project_session' as const;
export const CSRF_COOKIE = 'wdrg_csrf' as const;
export const CSRF_HEADER = 'x-csrf-token' as const;
