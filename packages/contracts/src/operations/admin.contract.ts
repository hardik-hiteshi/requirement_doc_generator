import { z } from 'zod';

import { AUDIT_EVENT_TYPES } from '../project/audit.contract';
import { PROJECT_STATUSES } from '../project/project-status';
import { retentionSweepResultSchema } from './retention.contract';

/**
 * The operator surface: what is happening, and what has been refused.
 *
 * ## Why a token rather than an account
 *
 * There are no user accounts in this system. A project *is* the principal — it is
 * reached with a recovery secret and carries no owner, no roles and no directory.
 * Adding sign-in for operators would mean inventing an identity system, a password
 * policy and a session model for a surface with one user, and every one of those is
 * a new thing to get wrong.
 *
 * So the operator surface is authenticated by a single token supplied as
 * configuration, held by whoever runs the deployment. It is absent by default,
 * which means the surface does not exist by default. That is a deliberate trade: it
 * gives no per-operator attribution, so `ADMIN_ACTION` records that an operator
 * acted and not which one. Where several people share a deployment they share a
 * token, and the audit trail says so honestly rather than implying otherwise.
 *
 * ## Read-mostly
 *
 * Everything here reads, with one exception: a retention sweep can be triggered so
 * an operator does not have to wait for the next tick after changing a policy. It
 * is audited, and it does exactly what the timer does — it cannot purge anything the
 * policy would not have purged on its own.
 */

/** Header carrying the operator token. Not `Authorization`, which the session uses. */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/** Shortest token production will accept. Long enough that guessing is hopeless. */
export const ADMIN_TOKEN_MIN_LENGTH = 32;

export const ADMIN_DISABLED_MESSAGE = 'The operator surface is not enabled on this deployment.';

export const ADMIN_UNAUTHORIZED_MESSAGE = 'That operator token was not accepted.';

/** Counts of projects by status. What an operator wants first. */
export const projectStatusCountsSchema = z
  .object(
    Object.fromEntries(
      PROJECT_STATUSES.map((status) => [status, z.number().int().nonnegative()]),
    ) as Record<(typeof PROJECT_STATUSES)[number], z.ZodNumber>,
  )
  .strict();

export const adminStatusSchema = z
  .object({
    /** Wall-clock at the moment of the read, so a stale page is obvious. */
    observedAt: z.string().datetime(),
    version: z.string().max(40),
    environment: z.string().max(20),
    projects: projectStatusCountsSchema,
    retention: z
      .object({
        enabled: z.boolean(),
        deletionGraceDays: z.number().int().nonnegative(),
        expiredGraceDays: z.number().int().positive(),
        /** Absent until the first sweep of this process. */
        lastSweep: retentionSweepResultSchema.optional(),
        /** Projects currently eligible, so an operator can see work waiting. */
        pendingDeletion: z.number().int().nonnegative(),
      })
      .strict(),
    rateLimit: z
      .object({
        enabled: z.boolean(),
        /** Distinct counter keys currently held in memory. */
        trackedKeys: z.number().int().nonnegative(),
        /** Refusals since this process started, by class. */
        refusals: z.record(z.string().max(20), z.number().int().nonnegative()),
      })
      .strict(),
    storage: z.object({ adapter: z.string().max(20), malwareScanner: z.string().max(20) }).strict(),
  })
  .strict();

export type AdminStatus = z.infer<typeof adminStatusSchema>;

/**
 * Audit visibility, filtered and paginated.
 *
 * Deliberately no free-text search across metadata: metadata is written to a policy
 * that keeps content out of it, and a search interface over it would invite putting
 * content in. Filtering is by type, project and time, which is what an
 * investigation actually needs.
 */
export const adminAuditQuerySchema = z
  .object({
    type: z.enum(AUDIT_EVENT_TYPES).optional(),
    projectId: z.string().min(1).max(64).optional(),
    since: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;

export const adminAuditEventSchema = z
  .object({
    type: z.enum(AUDIT_EVENT_TYPES),
    projectId: z.string().max(64),
    correlationId: z.string().max(64).optional(),
    occurredAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const adminAuditResponseSchema = z
  .object({
    events: z.array(adminAuditEventSchema).max(200),
    /** True when the limit truncated the result, so a reader knows to narrow it. */
    truncated: z.boolean(),
  })
  .strict();

export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;

export const ADMIN_ROUTES = {
  status: '/api/v1/admin/status',
  audit: '/api/v1/admin/audit',
  retentionRun: '/api/v1/admin/retention/run',
  metrics: '/api/v1/admin/metrics',
  projects: '/api/v1/admin/projects',
  project: (projectId: string) => `/api/v1/admin/projects/${projectId}`,
  queue: '/api/v1/admin/queue',
  jobRetry: (jobId: string) => `/api/v1/admin/queue/${jobId}/retry`,
  config: '/api/v1/admin/config',
} as const;

/**
 * Configuration an operator may read, by exact key.
 *
 * An allow-list rather than a deny-list, because the failure modes are not
 * symmetrical: forgetting to add a safe key means an operator asks; forgetting to
 * deny a new secret means publishing it. A key absent from this list is absent from
 * the response.
 *
 * Nothing here holds a credential. Where the *presence* of a secret matters — is the
 * session secret set, is the operator token set — the response carries a boolean
 * instead, which answers the operational question without disclosing anything.
 */
export const READABLE_CONFIG_KEYS: readonly string[] = [
  'NODE_ENV',
  'LOG_LEVEL',
  'API_PORT',
  'API_PUBLIC_URL',
  'WEB_PUBLIC_URL',
  'STORAGE_ADAPTER',
  'UPLOAD_STORAGE_ROOT',
  'S3_ENDPOINT',
  'S3_PORT',
  'S3_USE_SSL',
  'S3_BUCKET',
  'MALWARE_SCANNER',
  'CLAMAV_HOST',
  'CLAMAV_PORT',
  'AI_PROVIDER',
  'AI_BASE_URL',
  'AI_MODEL_PROFILE',
  'EXTRACTION_WORKER_ENABLED',
  'EXTRACTION_POLL_INTERVAL_MS',
  'EXTRACTION_CLAIM_TIMEOUT_MS',
  'PROJECT_EXPIRY_DAYS',
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_MAX_KEYS',
  'RETENTION_ENABLED',
  'RETENTION_SWEEP_INTERVAL_MS',
  'RETENTION_DELETION_GRACE_DAYS',
  'RETENTION_EXPIRED_GRACE_DAYS',
  'RETENTION_BATCH_SIZE',
  'OPENAPI_ENABLED',
];

/** Secrets reported as set or unset, never by value. */
export const CONFIG_PRESENCE_KEYS: readonly string[] = [
  'PROJECT_SESSION_SECRET',
  'PROJECT_SECRET_PEPPER',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'ADMIN_API_TOKEN',
];

export const adminConfigSchema = z
  .object({
    /** Allow-listed values, as strings — a config view is for reading, not parsing. */
    settings: z.record(z.string().max(60), z.string().max(500)),
    /** Whether each secret is configured. Never its value, never its length. */
    secretsConfigured: z.record(z.string().max(60), z.boolean()),
    observedAt: z.string().datetime(),
  })
  .strict();

export type AdminConfig = z.infer<typeof adminConfigSchema>;
