import {
  brandingSchema,
  outputPreferencesSchema,
  type Branding,
  projectResponseSchema,
  startDateSchema,
  teamCapacitySchema,
  timelineSchema,
  type CreateProjectRequest,
  type OutputPreferences,
  type ProjectDetails,
  type ProjectResponse,
  type ProjectStatus,
  type StartDate,
  type TeamCapacity,
  type Timeline,
} from '@wdrg/contracts';

import type { CreateProjectData, ProjectMutation, ProjectRecord } from '../project.repository';

/**
 * The mapping layer between the wire, the domain and persistence.
 *
 * Every field is named explicitly in both directions. That is the whole point:
 * a request field only reaches the database because a mapper put it there, and a
 * stored field only reaches a client because a mapper selected it. Neither
 * direction has a spread that would carry a new field along by accident.
 *
 * See ADR-0009 for why validation alone is not sufficient for this.
 */

/* ------------------------------------------------- request -> domain/create */

export interface CreateProjectCommand {
  readonly name: string;
  readonly clientName?: string;
  readonly internalReference?: string;
  readonly description?: string;
  readonly projectTypes?: readonly string[];
}

export function toCreateProjectCommand(request: CreateProjectRequest): CreateProjectCommand {
  return {
    name: request.name,
    clientName: request.clientName,
    internalReference: request.internalReference,
    description: request.description,
    projectTypes: request.projectTypes,
  };
}

/* ------------------------------------------------ domain -> persistence */

export function toCreateProjectData(
  command: CreateProjectCommand,
  identity: { projectId: string; secretHash: CreateProjectData['secretHash']; expiresAt: Date },
): CreateProjectData {
  return {
    projectId: identity.projectId,
    secretHash: identity.secretHash,
    expiresAt: identity.expiresAt,
    name: command.name,
    clientName: command.clientName,
    internalReference: command.internalReference,
    description: command.description,
    projectTypes: command.projectTypes,
  };
}

/**
 * Details update.
 *
 * `undefined` is meaningful here: the contract turns an empty optional field
 * into `undefined`, and the repository translates that into `$unset`. So
 * clearing a field in the UI clears it in the database, rather than leaving a
 * stale value because the key was simply absent.
 */
export function toDetailsMutation(details: ProjectDetails, status: ProjectStatus): ProjectMutation {
  return {
    name: details.name,
    clientName: details.clientName,
    internalReference: details.internalReference,
    description: details.description,
    projectTypes: details.projectTypes,
    status,
  };
}

export function toTimelineMutation(timeline: Timeline, status: ProjectStatus): ProjectMutation {
  return { timeline, status };
}

export function toStartDateMutation(startDate: StartDate, status: ProjectStatus): ProjectMutation {
  return { startDate, status };
}

export function toTeamCapacityMutation(
  capacity: TeamCapacity,
  status: ProjectStatus,
): ProjectMutation {
  return { teamCapacity: capacity, status };
}

/**
 * Branding changes presentation, so it leaves the project's status where it was.
 *
 * Every other section here calls `statusAfterEdit`, because editing scope, timeline or
 * capacity is a change to what the project *is*. A logo is not: if changing an accent
 * colour could move a project's status it could ripple into currentness, and a document
 * would go out of date because somebody picked a different blue.
 */
export function toBrandingMutation(branding: Branding, status: ProjectStatus): ProjectMutation {
  return { branding, status };
}

export function toOutputPreferencesMutation(
  preferences: OutputPreferences,
  status: ProjectStatus,
): ProjectMutation {
  return { outputPreferences: preferences, status };
}

/* ---------------------------------------------- persistence -> response */

/**
 * Maps a stored project to the API response.
 *
 * Structured sub-documents are re-validated on the way out. They were written
 * through a validating boundary, but a document could predate a schema change or
 * have been touched outside the application; parsing here means a response never
 * carries a shape the published contract does not describe. An unparseable
 * section is omitted rather than emitted malformed.
 */
export function toProjectResponse(
  record: ProjectRecord,
  effectiveStatus: ProjectStatus,
): ProjectResponse {
  const response: ProjectResponse = {
    projectId: record.projectId,
    status: effectiveStatus,
    version: record.version,

    name: record.name,
    clientName: record.clientName,
    internalReference: record.internalReference,
    description: record.description,
    projectTypes: parseSection(record.projectTypes, (value) =>
      projectResponseSchema.shape.projectTypes.parse(value),
    ),

    timeline: parseSection(record.timeline, (value) => timelineSchema.parse(value)),
    startDate: parseSection(record.startDate, (value) => startDateSchema.parse(value)),
    teamCapacity: parseSection(record.teamCapacity, (value) => teamCapacitySchema.parse(value)),
    outputPreferences: parseSection(record.outputPreferences, (value) =>
      outputPreferencesSchema.parse(value),
    ),
    branding: parseSection(record.branding, (value) => brandingSchema.parse(value)),

    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lastAccessedAt: record.lastAccessedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };

  return response;
}

function parseSection<TValue, TParsed>(
  value: TValue | undefined,
  parse: (value: TValue) => TParsed,
): TParsed | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return parse(value);
  } catch {
    // A stored section that no longer satisfies the contract is omitted rather
    // than returned. The user sees an empty section they can re-enter, which is
    // recoverable; a malformed payload that breaks the client is not.
    return undefined;
  }
}
