import { z } from 'zod';

/** Status of an individual dependency check. */
export const healthIndicatorStatusSchema = z.enum(['up', 'down']);
export type HealthIndicatorStatus = z.infer<typeof healthIndicatorStatusSchema>;

/** Overall outcome of a health probe. */
export const healthStatusSchema = z.enum(['ok', 'error', 'shutting_down']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

const indicatorRecordSchema = z.record(
  z.string(),
  z.object({ status: healthIndicatorStatusSchema }).loose(),
);

/**
 * Liveness answers "is this process alive and able to serve?". It must never
 * depend on external systems — a database outage must not cause an orchestrator
 * to kill an otherwise healthy pod.
 */
export const livenessResponseSchema = z.object({
  status: healthStatusSchema,
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string(),
});

export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

/**
 * Readiness answers "can this instance accept traffic right now?" and therefore
 * does check dependencies (database today; storage and job queue in later
 * phases).
 */
export const readinessResponseSchema = z.object({
  status: healthStatusSchema,
  info: indicatorRecordSchema.optional(),
  error: indicatorRecordSchema.optional(),
  details: indicatorRecordSchema,
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
