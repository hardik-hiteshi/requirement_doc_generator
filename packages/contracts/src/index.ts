/**
 * `@wdrg/contracts` is the single source of truth for anything that crosses the
 * web <-> api boundary: the HTTP envelope, the error model, health payloads and
 * the project domain vocabulary.
 *
 * Nothing in this package may import from `apps/*`. It must stay runtime-neutral
 * (no Node or DOM APIs) so it can be consumed by both the NestJS server and the
 * Next.js client bundle.
 */
export * from './http/headers';
export * from './http/api-routes';
export * from './http/api-error';
export * from './health/health.contract';
export * from './workflow/workflow-steps';

/* Phase 2 — public workspace and anonymous project lifecycle. */
export * from './project/project-identifiers';
export * from './project/project-status';
export * from './project/project-type.contract';
export * from './project/timeline.contract';
export * from './project/start-date.contract';
export * from './project/team-capacity.contract';
export * from './project/output-preferences.contract';
export * from './project/project.contract';
export * from './project/project-access.contract';
export * from './project/project-routes';
export * from './project/project-errors';
export * from './project/audit.contract';
