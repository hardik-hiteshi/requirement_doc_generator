'use client';

import {
  MAX_PROJECT_TYPES,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  type ProjectDetails,
  type ProjectResponse,
  type ProjectType,
} from '@wdrg/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
} from '@wdrg/ui';
import { useState } from 'react';

import { useSectionSave } from '@/hooks/use-project';
import { updateDetails } from '@/lib/project-api';
import { SaveStatus } from './save-status';

/** Editable project information. */
export function DetailsSection({ project }: { project: ProjectResponse }) {
  const [details, setDetails] = useState<ProjectDetails>(() => ({
    name: project.name,
    clientName: project.clientName,
    internalReference: project.internalReference,
    description: project.description,
    projectTypes: project.projectTypes,
  }));

  const { save, state, message, fieldErrors } = useSectionSave<{ details: ProjectDetails }>({
    mutate: updateDetails,
  });

  const selectedTypes: ProjectType[] = details.projectTypes ? [...details.projectTypes] : [];

  function toggleType(type: ProjectType) {
    const next = selectedTypes.includes(type)
      ? selectedTypes.filter((value) => value !== type)
      : selectedTypes.length < MAX_PROJECT_TYPES
        ? [...selectedTypes, type]
        : selectedTypes;

    setDetails({ ...details, projectTypes: next.length > 0 ? next : undefined });
  }

  const errorFor = (path: string) =>
    fieldErrors?.find((detail) => detail.path === path || detail.path === `details.${path}`)
      ?.message;

  return (
    <Card role="region" aria-labelledby="details-section-title">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle id="details-section-title">Project details</CardTitle>
            <CardDescription>Basic information about the project and the client.</CardDescription>
          </div>
          <SaveStatus state={state} message={message} />
        </div>
      </CardHeader>

      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            save({ details });
          }}
        >
          <Field label="Project name" required error={errorFor('name')}>
            {(props) => (
              <Input
                {...props}
                value={details.name}
                onChange={(event) => setDetails({ ...details, name: event.target.value })}
              />
            )}
          </Field>

          <Field label="Client name" error={errorFor('clientName')}>
            {(props) => (
              <Input
                {...props}
                value={details.clientName ?? ''}
                onChange={(event) => setDetails({ ...details, clientName: event.target.value })}
              />
            )}
          </Field>

          <Field label="Internal reference" error={errorFor('internalReference')}>
            {(props) => (
              <Input
                {...props}
                value={details.internalReference ?? ''}
                onChange={(event) =>
                  setDetails({ ...details, internalReference: event.target.value })
                }
              />
            )}
          </Field>

          <Field label="Description or notes" error={errorFor('description')}>
            {(props) => (
              <Textarea
                {...props}
                rows={4}
                value={details.description ?? ''}
                onChange={(event) => setDetails({ ...details, description: event.target.value })}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Project type</legend>
            <p className="text-xs text-muted">
              Required before the technology-stack and estimation steps. It determines the stack
              categories offered, the roles assumed, the testing and deployment activities, and the
              wording of the Statement of Work.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {PROJECT_TYPES.map((type) => {
                const checked = selectedTypes.includes(type);

                return (
                  <label
                    key={type}
                    className={`flex items-center gap-2.5 rounded-md border p-2 text-sm ${
                      checked ? 'border-accent bg-accent-soft' : 'border-border'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selectedTypes.length >= MAX_PROJECT_TYPES}
                      onChange={() => toggleType(type)}
                      className="size-4 shrink-0 rounded border-border"
                    />
                    {PROJECT_TYPE_LABELS[type]}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Button type="submit" disabled={state === 'saving'} className="self-start">
            {state === 'saving' ? 'Saving…' : 'Save details'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
