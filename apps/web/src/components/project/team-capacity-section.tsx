'use client';

import {
  CAPACITY_LIMITS,
  STANDARD_ROLES,
  STANDARD_ROLE_LABELS,
  type ProjectResponse,
  type StandardRole,
  type TeamCapacity,
} from '@wdrg/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
} from '@wdrg/ui';
import { useState } from 'react';

import { useSectionSave } from '@/hooks/use-project';
import { updateTeamCapacity } from '@/lib/project-api';
import { SaveStatus } from './save-status';

/**
 * Optional team and capacity inputs.
 *
 * Left empty, the estimation phase will propose the staffing needed to hit the
 * timeline. Filled in, it constrains the plan instead. The panel says so, since
 * an empty form otherwise looks like something the user forgot.
 */
export function TeamCapacitySection({ project }: { project: ProjectResponse }) {
  const [capacity, setCapacity] = useState<TeamCapacity>(() => project.teamCapacity ?? {});
  const { save, state, message, fieldErrors } = useSectionSave<{ teamCapacity: TeamCapacity }>({
    mutate: updateTeamCapacity,
  });

  const customRoles = capacity.customRoles ?? [];

  function setRole(role: StandardRole, value: string) {
    const parsed = value === '' ? undefined : Number(value);
    const roles = { ...(capacity.roles ?? {}) };

    if (parsed === undefined || Number.isNaN(parsed)) {
      delete roles[role];
    } else {
      roles[role] = parsed;
    }

    setCapacity({ ...capacity, roles: Object.keys(roles).length > 0 ? roles : undefined });
  }

  function setNumber(key: keyof TeamCapacity, value: string) {
    const parsed = value === '' ? undefined : Number(value);
    setCapacity({ ...capacity, [key]: Number.isNaN(parsed) ? undefined : parsed });
  }

  const customRoleError = (index: number) =>
    fieldErrors?.find((detail) => detail.path.includes(`customRoles.${index}`))?.message;

  return (
    <Card role="region" aria-labelledby="team-capacity-section-title">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle id="team-capacity-section-title">Team and capacity</CardTitle>
            <CardDescription>
              All optional. Leave it blank and the estimate will propose the staffing needed to meet
              your timeline; fill it in and the plan is built around the team you have.
            </CardDescription>
          </div>
          <SaveStatus state={state} message={message} />
        </div>
      </CardHeader>

      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            save({ teamCapacity: capacity });
          }}
        >
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Roles</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {STANDARD_ROLES.map((role) => (
                <Field key={role} label={STANDARD_ROLE_LABELS[role]}>
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={CAPACITY_LIMITS.roleCount.min}
                      max={CAPACITY_LIMITS.roleCount.max}
                      value={capacity.roles?.[role] ?? ''}
                      onChange={(event) => setRole(role, event.target.value)}
                    />
                  )}
                </Field>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Additional roles</legend>
            {customRoles.map((role, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Field label="Role name" error={customRoleError(index)}>
                    {(props) => (
                      <Input
                        {...props}
                        value={role.name}
                        onChange={(event) => {
                          const next = [...customRoles];
                          next[index] = { ...role, name: event.target.value };
                          setCapacity({ ...capacity, customRoles: next });
                        }}
                      />
                    )}
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Count">
                    {(props) => (
                      <Input
                        {...props}
                        type="number"
                        min={0}
                        value={role.count}
                        onChange={(event) => {
                          const next = [...customRoles];
                          next[index] = { ...role, count: Number(event.target.value) };
                          setCapacity({ ...capacity, customRoles: next });
                        }}
                      />
                    )}
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setCapacity({
                      ...capacity,
                      customRoles: customRoles.filter((_, position) => position !== index),
                    })
                  }
                >
                  Remove<span className="sr-only"> {role.name || `role ${index + 1}`}</span>
                </Button>
              </div>
            ))}

            <Button
              type="button"
              variant="secondary"
              className="self-start"
              disabled={customRoles.length >= CAPACITY_LIMITS.maxCustomRoles}
              onClick={() =>
                setCapacity({ ...capacity, customRoles: [...customRoles, { name: '', count: 1 }] })
              }
            >
              Add a role
            </Button>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <legend className="mb-1 text-sm font-medium">Working pattern</legend>

            <Field label="Working hours per day">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={CAPACITY_LIMITS.workingHoursPerDay.min}
                  max={CAPACITY_LIMITS.workingHoursPerDay.max}
                  value={capacity.workingHoursPerDay ?? ''}
                  onChange={(event) => setNumber('workingHoursPerDay', event.target.value)}
                />
              )}
            </Field>

            <Field label="Working days per week">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={CAPACITY_LIMITS.workingDaysPerWeek.min}
                  max={CAPACITY_LIMITS.workingDaysPerWeek.max}
                  value={capacity.workingDaysPerWeek ?? ''}
                  onChange={(event) => setNumber('workingDaysPerWeek', event.target.value)}
                />
              )}
            </Field>

            <Field label="Client review (days)">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  value={capacity.clientReviewDays ?? ''}
                  onChange={(event) => setNumber('clientReviewDays', event.target.value)}
                />
              )}
            </Field>

            <Field label="UAT (days)">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  value={capacity.uatDays ?? ''}
                  onChange={(event) => setNumber('uatDays', event.target.value)}
                />
              )}
            </Field>

            <Field label="Deployment (days)">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  value={capacity.deploymentDays ?? ''}
                  onChange={(event) => setNumber('deploymentDays', event.target.value)}
                />
              )}
            </Field>
          </fieldset>

          <div className="flex flex-col gap-2.5">
            <Checkbox
              label="Weekends are working days"
              checked={capacity.includeWeekends ?? false}
              onChange={(event) =>
                setCapacity({ ...capacity, includeWeekends: event.currentTarget.checked })
              }
            />
            <Checkbox
              label="Work can run in parallel"
              description="Allows independent workstreams to overlap when scheduling."
              checked={capacity.parallelExecutionAllowed ?? false}
              onChange={(event) =>
                setCapacity({ ...capacity, parallelExecutionAllowed: event.currentTarget.checked })
              }
            />
            <Checkbox
              label="Recommend the staffing needed to meet my timeline"
              description="The estimate will propose a team rather than assuming the counts above."
              checked={capacity.requestStaffingRecommendation ?? false}
              onChange={(event) =>
                setCapacity({
                  ...capacity,
                  requestStaffingRecommendation: event.currentTarget.checked,
                })
              }
            />
          </div>

          <Button type="submit" disabled={state === 'saving'} className="self-start">
            {state === 'saving' ? 'Saving…' : 'Save team and capacity'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
