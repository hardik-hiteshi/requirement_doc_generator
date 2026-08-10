import { z } from 'zod';

import type { ProjectType } from '../project/project-type.contract';
import type { TechnologyCategory } from '../stack/technology-category.contract';

/**
 * Who does the work.
 *
 * A closed list, because every number downstream is per role: the capacity
 * calculation, the staffing recommendation, the utilisation view, and
 * eventually the commercial sections of a Statement of Work. A free-text role
 * would be a column nobody could price.
 *
 * **Roles are offered, never assumed.** An API-only project has no frontend
 * work and a static website has no backend work, and an estimate that quietly
 * assigns eighty hours to a role the project does not have is an invoice line
 * for something nobody is building. Applicability is derived from the project
 * type and the *locked* technology stack — see `applicableRoles`.
 */
export const ESTIMATION_ROLES = [
  'BACKEND',
  'FRONTEND',
  'MOBILE',
  'QA',
  'UI_UX',
  'DEVOPS',
  'BA',
  'PM',
  'SOLUTION_ARCHITECT',
  'AI_ML',
  'DATA_ENGINEER',
] as const;

export type EstimationRole = (typeof ESTIMATION_ROLES)[number];
export const estimationRoleSchema = z.enum(ESTIMATION_ROLES);

export const ESTIMATION_ROLE_LABELS: Readonly<Record<EstimationRole, string>> = {
  BACKEND: 'Backend',
  FRONTEND: 'Frontend',
  MOBILE: 'Mobile',
  QA: 'QA',
  UI_UX: 'UI/UX',
  DEVOPS: 'DevOps',
  BA: 'Business analysis',
  PM: 'Project management',
  SOLUTION_ARCHITECT: 'Solution architecture',
  AI_ML: 'AI/ML',
  DATA_ENGINEER: 'Data engineering',
};

/**
 * A role the user named that the standard list does not cover.
 *
 * Kept apart from `EstimationRole` rather than merged into it, so the closed
 * list stays closed: nothing in the application can be surprised by a role it
 * has never seen, and a model cannot invent one — the structured-output
 * validator checks every role against this project's configured set.
 */
export const customEstimationRoleSchema = z
  .object({
    /** Stable within a project. Used as the key in effort maps. */
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^custom:[a-z0-9][a-z0-9-]*$/, 'Custom role keys are prefixed and hyphenated'),
    label: z.string().min(2).max(60),
  })
  .strict();

export type CustomEstimationRole = z.infer<typeof customEstimationRoleSchema>;

/** Either a standard role or a project-specific one. */
export const roleKeySchema = z.union([estimationRoleSchema, z.string().min(1).max(60)]);
export type RoleKey = string;

export function isStandardRole(key: string): key is EstimationRole {
  return (ESTIMATION_ROLES as readonly string[]).includes(key);
}

export function isCustomRoleKey(key: string): boolean {
  return key.startsWith('custom:');
}

export function customRoleKeyFor(label: string): string {
  const slug = label
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `custom:${slug || 'role'}`;
}

/* --------------------------------------------------------- applicability */

/**
 * Which roles this project can legitimately have work in.
 *
 * Derived from two authoritative things and nothing else: the project types the
 * user confirmed, and the categories the *locked* stack actually filled. A role
 * that survives this filter may still be zero; a role that does not survive it
 * cannot be given hours at all.
 *
 * The clearest cases are the ones the specification names. An API-only project
 * has no `FRONTEND`. A static website has no `BACKEND`. A project with no mobile
 * technology in its stack has no `MOBILE`, whatever the brief said.
 */
export function applicableRoles(input: {
  readonly projectTypes: readonly ProjectType[];
  /** Categories the locked stack has a live technology in. */
  readonly stackCategories: readonly TechnologyCategory[];
  /** Custom roles configured for this project. */
  readonly customRoles?: readonly CustomEstimationRole[];
}): readonly RoleKey[] {
  const categories = new Set(input.stackCategories);
  const types = new Set(input.projectTypes);
  const roles: EstimationRole[] = [];

  const add = (role: EstimationRole): void => {
    if (!roles.includes(role)) {
      roles.push(role);
    }
  };

  /*
   * Implementation roles follow the stack, not the brief. The stack is the
   * locked record of what is being built; the brief is prose. If the stack has
   * no mobile framework and no native platform, nobody is writing mobile code
   * however the project was described.
   */
  if (categories.has('backend') || categories.has('database') || categories.has('api_gateway')) {
    add('BACKEND');
  }

  if (categories.has('web_frontend') || categories.has('content_management')) {
    add('FRONTEND');
  }

  if (
    categories.has('mobile_framework') ||
    categories.has('native_android') ||
    categories.has('native_ios')
  ) {
    add('MOBILE');
  }

  if (categories.has('desktop_framework')) {
    // Desktop work is written by the frontend discipline in every team this
    // application is built for. A separate role would be a column nobody staffs.
    add('FRONTEND');
  }

  if (categories.has('ai_model') || categories.has('ai_runtime') || types.has('AI_ML_SOLUTION')) {
    add('AI_ML');
  }

  if (
    categories.has('data_processing') ||
    types.has('MIGRATION') ||
    types.has('SYSTEM_INTEGRATION')
  ) {
    add('DATA_ENGINEER');
  }

  /*
   * Design applies wherever a person looks at a screen. It does not apply to a
   * service that only other systems call.
   */
  if (
    categories.has('web_frontend') ||
    categories.has('mobile_framework') ||
    categories.has('native_android') ||
    categories.has('native_ios') ||
    categories.has('desktop_framework')
  ) {
    add('UI_UX');
  }

  /* Everything gets tested, coordinated, specified and deployed. */
  add('QA');
  add('DEVOPS');
  add('BA');
  add('PM');

  /*
   * Architecture is not universal. A brochure site does not need a solution
   * architect, and pricing one is padding with a job title on it.
   */
  if (
    categories.has('backend') ||
    categories.has('integrations') ||
    categories.has('message_queue') ||
    types.has('SAAS_PLATFORM') ||
    types.has('SYSTEM_INTEGRATION') ||
    types.has('MULTI_PLATFORM_PRODUCT') ||
    types.has('MODERNISATION')
  ) {
    add('SOLUTION_ARCHITECT');
  }

  return [...roles, ...(input.customRoles ?? []).map((role) => role.key)];
}

/**
 * The label for any role key, standard or custom.
 *
 * One function so no screen ever renders a raw `custom:qa-lead`.
 */
export function roleLabel(key: RoleKey, customRoles: readonly CustomEstimationRole[] = []): string {
  if (isStandardRole(key)) {
    return ESTIMATION_ROLE_LABELS[key];
  }

  return customRoles.find((role) => role.key === key)?.label ?? key;
}

/**
 * Effort per role, in hours.
 *
 * A partial map rather than a full record: an absent role means *no work of that
 * kind*, which is a different statement from zero hours and reads differently in
 * a breakdown. Nothing here forces a role to appear.
 */
export const roleEffortSchema = z.record(z.string().min(1).max(60), z.number().min(0).max(100_000));

export type RoleEffort = z.infer<typeof roleEffortSchema>;

export function totalRoleEffort(effort: RoleEffort): number {
  return Number(
    Object.values(effort)
      .reduce((total, hours) => total + hours, 0)
      .toFixed(2),
  );
}

/** Sums several role maps into one. Used for feature → module → project totals. */
export function sumRoleEffort(...maps: readonly RoleEffort[]): RoleEffort {
  const total: Record<string, number> = {};

  for (const map of maps) {
    for (const [role, hours] of Object.entries(map)) {
      total[role] = Number(((total[role] ?? 0) + hours).toFixed(2));
    }
  }

  return total;
}
