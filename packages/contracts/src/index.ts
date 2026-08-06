/**
 * `@wdrg/contracts` is the single source of truth for anything that crosses the
 * web <-> api boundary: the HTTP envelope, the error model, health payloads and
 * workflow domain constants.
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
