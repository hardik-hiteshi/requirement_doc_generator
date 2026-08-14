import { z } from 'zod';

import { brandingSchema } from './branding.contract';
import { outputPreferencesSchema } from './output-preferences.contract';
import { PROJECT_ID_PATTERN } from './project-identifiers';
import { PROJECT_STATUSES } from './project-status';
import { projectTypeSelectionSchema } from './project-type.contract';
import { startDateSchema } from './start-date.contract';
import { teamCapacitySchema } from './team-capacity.contract';
import { timelineSchema } from './timeline.contract';

/** Field limits, shared so browser and server agree exactly. */
export const PROJECT_FIELD_LIMITS = {
  name: { min: 1, max: 200 },
  clientName: { max: 200 },
  internalReference: { max: 100 },
  description: { max: 10_000 },
} as const;

/**
 * A trimmed, non-empty string. Applied before length checks so a field of only
 * spaces is rejected as empty rather than accepted as 3 characters.
 */
const requiredText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'Required').max(max));

/** Optional text where an empty string means "cleared", stored as undefined. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

export const projectDetailsSchema = z.object({
  name: requiredText(PROJECT_FIELD_LIMITS.name.max),
  clientName: optionalText(PROJECT_FIELD_LIMITS.clientName.max),
  internalReference: optionalText(PROJECT_FIELD_LIMITS.internalReference.max),
  description: optionalText(PROJECT_FIELD_LIMITS.description.max),
  /**
   * Optional here so a project can be created before it is decided, but
   * required by the technology-stack and estimation phases — see
   * `project-type.contract.ts`.
   */
  projectTypes: projectTypeSelectionSchema.optional(),
});

export type ProjectDetails = z.infer<typeof projectDetailsSchema>;

/* ------------------------------------------------------------------ create */

export const createProjectRequestSchema = z.object({
  name: requiredText(PROJECT_FIELD_LIMITS.name.max),
  clientName: optionalText(PROJECT_FIELD_LIMITS.clientName.max),
  internalReference: optionalText(PROJECT_FIELD_LIMITS.internalReference.max),
  description: optionalText(PROJECT_FIELD_LIMITS.description.max),
  projectTypes: projectTypeSelectionSchema.optional(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/* ------------------------------------------------------------------- read */

/**
 * The project as returned to a client.
 *
 * Contains no database identifier, no secret hash and no session material. The
 * response shape is the boundary — a field absent here cannot leak by accident
 * from a repository that happens to select it.
 */
export const projectResponseSchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  status: z.enum(PROJECT_STATUSES),
  /** Incremented on every accepted write. Sent back to detect a stale update. */
  version: z.number().int().nonnegative(),

  name: z.string(),
  clientName: z.string().optional(),
  internalReference: z.string().optional(),
  description: z.string().optional(),
  projectTypes: projectTypeSelectionSchema.optional(),

  timeline: timelineSchema.optional(),
  startDate: startDateSchema.optional(),
  teamCapacity: teamCapacitySchema.optional(),
  outputPreferences: outputPreferencesSchema.optional(),
  /** How exports are presented. Presentation only; never document authority. */
  branding: brandingSchema.optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
  lastAccessedAt: z.string(),
  expiresAt: z.string(),
});

export type ProjectResponse = z.infer<typeof projectResponseSchema>;

/* ----------------------------------------------------------------- update */

export const updateProjectDetailsRequestSchema = z.object({
  details: projectDetailsSchema,
  version: z.number().int().nonnegative(),
});

export type UpdateProjectDetailsRequest = z.infer<typeof updateProjectDetailsRequestSchema>;

/* ----------------------------------------------------------------- delete */

/**
 * Deletion requires the typed project name.
 *
 * A one-click delete on an unrecoverable, account-less project is a trap: there
 * is no support channel that can undo it. Requiring the name makes the action
 * deliberate.
 */
export const deleteProjectRequestSchema = z.object({
  confirmationName: z.string().min(1),
  version: z.number().int().nonnegative(),
});

export type DeleteProjectRequest = z.infer<typeof deleteProjectRequestSchema>;

export const deleteProjectResponseSchema = z.object({
  projectId: z.string(),
  status: z.enum(PROJECT_STATUSES),
  deletedAt: z.string(),
});

export type DeleteProjectResponse = z.infer<typeof deleteProjectResponseSchema>;
