import { z } from 'zod';

import { projectResponseSchema } from './project.contract';
import { PROJECT_ID_PATTERN, RECOVERY_SECRET_PATTERN } from './project-identifiers';

/**
 * Anonymous project access.
 *
 * The recovery secret is returned exactly once, when the project is created. It
 * is never retrievable afterwards, because the server keeps only a hash of it —
 * so a user who loses the recovery link loses the project. The UI has to say
 * that plainly rather than burying it.
 */

/**
 * Shown once, at creation. The client is responsible for getting this in front
 * of the user before they navigate away.
 */
export const projectCreatedResponseSchema = z.object({
  project: projectResponseSchema,
  /** Raw recovery secret. Returned once and never again. */
  recoverySecret: z.string().regex(RECOVERY_SECRET_PATTERN),
  /** Ready-to-copy link with the secret in the URL fragment. */
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
  'Anyone with this link can open, edit and delete this project. It is shown once and cannot be recovered — save it somewhere safe before continuing.' as const;

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
