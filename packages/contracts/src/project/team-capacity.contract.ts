import { z } from 'zod';

/**
 * Optional team and capacity inputs.
 *
 * Everything here is optional by design. When capacity is absent the later
 * estimation phase recommends the staffing needed to meet the stated timeline;
 * when it is present it constrains the plan instead. Neither behaviour is
 * implemented in this phase — this is the input surface only.
 */

/** Roles the product knows about, in the order the form presents them. */
export const STANDARD_ROLES = [
  'frontendDeveloper',
  'backendDeveloper',
  'qaEngineer',
  'uiUxDesigner',
  'devOpsEngineer',
  'businessAnalyst',
  'projectManager',
  'solutionArchitect',
  'aiMlEngineer',
] as const;

export type StandardRole = (typeof STANDARD_ROLES)[number];

export const STANDARD_ROLE_LABELS: Readonly<Record<StandardRole, string>> = {
  frontendDeveloper: 'Frontend developer',
  backendDeveloper: 'Backend developer',
  qaEngineer: 'QA engineer',
  uiUxDesigner: 'UI/UX designer',
  devOpsEngineer: 'DevOps engineer',
  businessAnalyst: 'Business Analyst',
  projectManager: 'Project Manager',
  solutionArchitect: 'Solution Architect',
  aiMlEngineer: 'AI/ML engineer',
};

export const CAPACITY_LIMITS = {
  /** Per role. Generous, but bounded so a typo cannot produce a nonsense plan. */
  roleCount: { min: 0, max: 500 },
  workingHoursPerDay: { min: 1, max: 24 },
  workingDaysPerWeek: { min: 1, max: 7 },
  /** Client review, UAT and deployment windows, in working days. */
  durationDays: { min: 0, max: 365 },
  customRoleNameLength: { min: 2, max: 60 },
  maxCustomRoles: 20,
} as const;

const roleCountSchema = z
  .number()
  .int()
  .min(CAPACITY_LIMITS.roleCount.min)
  .max(CAPACITY_LIMITS.roleCount.max);

/**
 * Custom role names are normalised before comparison so "QA Lead", "qa lead"
 * and "QA  Lead" are recognised as the same role. Without this, duplicate
 * detection would pass and the estimate would double-count the role.
 */
export function normalizeCustomRoleName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Comparison key for duplicate detection. Case-insensitive. */
export function customRoleKey(name: string): string {
  return normalizeCustomRoleName(name).toLocaleLowerCase();
}

export const customRoleSchema = z.object({
  name: z
    .string()
    .transform(normalizeCustomRoleName)
    .pipe(
      z
        .string()
        .min(CAPACITY_LIMITS.customRoleNameLength.min)
        .max(CAPACITY_LIMITS.customRoleNameLength.max)
        // Letters, digits, spaces and a few separators. Excludes characters that
        // would be awkward in an exported spreadsheet cell.
        .regex(/^[\p{L}\p{N} .,'()/&+-]+$/u, 'Contains unsupported characters'),
    ),
  count: roleCountSchema,
});

export type CustomRole = z.infer<typeof customRoleSchema>;

export const teamCapacitySchema = z
  .object({
    /**
     * Absent means "not stated", which is different from zero.
     *
     * `partialRecord`, not `record`: with an enum key Zod requires every member
     * to be present, which would force a caller to send a count for all nine
     * roles just to state one.
     */
    roles: z.partialRecord(z.enum(STANDARD_ROLES), roleCountSchema).optional(),
    customRoles: z.array(customRoleSchema).max(CAPACITY_LIMITS.maxCustomRoles).optional(),

    workingHoursPerDay: z
      .number()
      .min(CAPACITY_LIMITS.workingHoursPerDay.min)
      .max(CAPACITY_LIMITS.workingHoursPerDay.max)
      .optional(),
    workingDaysPerWeek: z
      .number()
      .int()
      .min(CAPACITY_LIMITS.workingDaysPerWeek.min)
      .max(CAPACITY_LIMITS.workingDaysPerWeek.max)
      .optional(),
    includeWeekends: z.boolean().optional(),
    parallelExecutionAllowed: z.boolean().optional(),

    clientReviewDays: z
      .number()
      .int()
      .min(CAPACITY_LIMITS.durationDays.min)
      .max(CAPACITY_LIMITS.durationDays.max)
      .optional(),
    uatDays: z
      .number()
      .int()
      .min(CAPACITY_LIMITS.durationDays.min)
      .max(CAPACITY_LIMITS.durationDays.max)
      .optional(),
    deploymentDays: z
      .number()
      .int()
      .min(CAPACITY_LIMITS.durationDays.min)
      .max(CAPACITY_LIMITS.durationDays.max)
      .optional(),

    /**
     * The user asking the system to propose staffing later. Recorded here;
     * acted on in the estimation phase.
     */
    requestStaffingRecommendation: z.boolean().optional(),
  })
  .superRefine((capacity, ctx) => {
    if (!capacity.customRoles) {
      return;
    }

    const seen = new Set<string>();

    capacity.customRoles.forEach((role, index) => {
      const key = customRoleKey(role.name);

      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['customRoles', index, 'name'],
          message: 'This role has already been added.',
        });
      }

      seen.add(key);

      const standardMatch = STANDARD_ROLES.find(
        (standard) => STANDARD_ROLE_LABELS[standard].toLocaleLowerCase() === key,
      );

      if (standardMatch) {
        ctx.addIssue({
          code: 'custom',
          path: ['customRoles', index, 'name'],
          message: 'This role already exists above — set its count there instead.',
        });
      }
    });
  });

export type TeamCapacity = z.infer<typeof teamCapacitySchema>;

export const updateTeamCapacityRequestSchema = z.object({
  teamCapacity: teamCapacitySchema,
  version: z.number().int().nonnegative(),
});

export type UpdateTeamCapacityRequest = z.infer<typeof updateTeamCapacityRequestSchema>;

/** True when the user supplied nothing beyond defaults. */
export function isCapacityEmpty(capacity: TeamCapacity | undefined): boolean {
  if (!capacity) {
    return true;
  }

  const hasRoleCounts = Object.values(capacity.roles ?? {}).some((count) => (count ?? 0) > 0);
  const hasCustomRoles = (capacity.customRoles ?? []).length > 0;

  return !hasRoleCounts && !hasCustomRoles;
}
